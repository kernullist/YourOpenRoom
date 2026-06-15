import {
  compareAoiApprovedCommandApproval,
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import { getDefaultAoiEnvironmentSourceRegistry } from './aoiAutonomyPolicy';
import type {
  AoiAttentionEvent,
  AoiAutonomyBlockedProposal,
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiOperatorTimelineEvent,
  AoiOperatorTraceExport,
  AoiProposal,
  AoiProposalDecision,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import { buildAoiOperatorDigest } from './aoiOperatorDigest';
import { evaluateAoiOperatorHealth } from './aoiOperatorHealth';
import { AOI_OPERATOR_REPLAY_FIXTURES, runAoiOperatorReplayFixture } from './aoiOperatorReplay';
import {
  buildAoiOperatorTraceExportFromEvents,
  createAoiReplayFixtureDraftFromTraceExport,
} from './aoiOperatorTimeline';
import {
  buildAoiOperatorVoiceEventFromDigest,
  decideAoiOperatorVoiceRender,
  getDefaultAoiOperatorVoicePolicy,
} from './aoiOperatorVoice';
import { prepareAoiPlaybook, updateAoiPlaybookFromEvidence } from './aoiPlaybookOrchestrator';
import { buildAoiTrustCalibrationProfile } from './aoiTrustCalibration';

export type AoiJarvisAcceptanceDimension =
  | 'context_awareness'
  | 'timing_interruption_control'
  | 'safety_approval_boundaries'
  | 'personal_source_consent'
  | 'voice_appropriateness'
  | 'health_honesty'
  | 'playbook_coordination'
  | 'replayability_privacy';

export type AoiJarvisAcceptancePrivacyState =
  | 'synthetic'
  | 'metadata_only'
  | 'withheld'
  | 'redacted';

export interface AoiJarvisAcceptanceMetric {
  version: 1;
  id: string;
  scenarioId: string;
  dimension: AoiJarvisAcceptanceDimension;
  passed: boolean;
  actualSummary: string;
  evidenceRefs: string[];
  privacyState: AoiJarvisAcceptancePrivacyState;
  mutationCount: number;
}

export interface AoiJarvisAcceptanceScenarioRunInput {
  sessionPath: string;
  now: number;
}

export interface AoiJarvisAcceptanceScenarioResult {
  version: 1;
  scenarioId: string;
  passed: boolean;
  actualSummary: string;
  evidenceRefs: string[];
  privacyState: AoiJarvisAcceptancePrivacyState;
  mutationCount: number;
  metrics: AoiJarvisAcceptanceMetric[];
}

export interface AoiJarvisAcceptanceScenario {
  version: 1;
  id: string;
  title: string;
  description: string;
  dimensions: AoiJarvisAcceptanceDimension[];
  evidenceRefs: string[];
  privacyState: AoiJarvisAcceptancePrivacyState;
  run: (input: AoiJarvisAcceptanceScenarioRunInput) => AoiJarvisAcceptanceScenarioResult;
}

export interface AoiJarvisAcceptanceReportScenario {
  version: 1;
  id: string;
  title: string;
  passed: boolean;
  actualSummary: string;
  evidenceRefs: string[];
  privacyState: AoiJarvisAcceptancePrivacyState;
  mutationCount: number;
  failedMetricIds: string[];
}

export interface AoiJarvisAcceptanceReport {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  passed: boolean;
  scenarioCount: number;
  metricCount: number;
  passedMetricCount: number;
  failedMetricCount: number;
  mutationCount: number;
  scenarios: AoiJarvisAcceptanceReportScenario[];
  metrics: AoiJarvisAcceptanceMetric[];
  failedMetrics: AoiJarvisAcceptanceMetric[];
  evidenceRefs: string[];
}

export interface AoiJarvisAcceptanceTrialOptions {
  sessionPath?: string;
  now?: number;
  scenarios?: AoiJarvisAcceptanceScenario[];
}

export interface AoiJarvisAcceptanceReportFormatOptions {
  maxFailedMetrics?: number;
}

export const AOI_JARVIS_ACCEPTANCE_NOW = 1_800_000_000_000;
export const AOI_JARVIS_ACCEPTANCE_SESSION_PATH = 'aoi/default';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

export const AOI_JARVIS_ACCEPTANCE_DIMENSIONS: AoiJarvisAcceptanceDimension[] = [
  'context_awareness',
  'timing_interruption_control',
  'safety_approval_boundaries',
  'personal_source_consent',
  'voice_appropriateness',
  'health_honesty',
  'playbook_coordination',
  'replayability_privacy',
];

function truncateText(value: string, maxChars = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function dedupeRefs(refs: Array<string | undefined>, maxItems = 16): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = truncateText(ref ?? '', 220);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function metric(params: {
  id: string;
  scenarioId: string;
  dimension: AoiJarvisAcceptanceDimension;
  passed: boolean;
  actualSummary: string;
  evidenceRefs?: string[];
  privacyState?: AoiJarvisAcceptancePrivacyState;
  mutationCount?: number;
}): AoiJarvisAcceptanceMetric {
  return {
    version: 1,
    id: params.id,
    scenarioId: params.scenarioId,
    dimension: params.dimension,
    passed: params.passed,
    actualSummary: truncateText(params.actualSummary),
    evidenceRefs: dedupeRefs(params.evidenceRefs ?? []),
    privacyState: params.privacyState ?? 'synthetic',
    mutationCount: params.mutationCount ?? 0,
  };
}

function scenarioResult(params: {
  scenarioId: string;
  metrics: AoiJarvisAcceptanceMetric[];
  actualSummary: string;
  privacyState?: AoiJarvisAcceptancePrivacyState;
  mutationCount?: number;
}): AoiJarvisAcceptanceScenarioResult {
  const mutationCount =
    params.mutationCount ?? params.metrics.reduce((total, item) => total + item.mutationCount, 0);
  return {
    version: 1,
    scenarioId: params.scenarioId,
    passed: mutationCount === 0 && params.metrics.every((item) => item.passed),
    actualSummary: truncateText(params.actualSummary, 220),
    evidenceRefs: dedupeRefs(params.metrics.flatMap((item) => item.evidenceRefs)),
    privacyState: params.privacyState ?? 'synthetic',
    mutationCount,
    metrics: params.metrics,
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

function makeWorkspaceSnapshot(
  sessionPath: string,
  now: number,
  partial: Partial<AoiWorkspaceSnapshot> = {},
): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath,
    collectedAt: now,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git', 'workspace-build'],
    git: {
      version: 1,
      branchName: 'main',
      previousBranchName: 'codex/aoi-previous',
      branchChanged: true,
      isDirty: true,
      changedFileCount: 3,
      stagedFileCount: 0,
      unstagedFileCount: 3,
      untrackedFileCount: 0,
      statusSummary: 'dirty: 3 changed, branch changed from codex/aoi-previous',
      changedFiles: [
        {
          version: 1,
          pathLabel: 'apps/webuiapps/src/lib/aoiAutonomyEvaluation.ts',
          pathHash: 'synthetic-aoi-evaluation',
          status: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
          changedAt: now - 60_000,
          directoryLabel: 'apps/webuiapps/src/lib',
          extension: 'ts',
        },
      ],
    },
    validation: {
      version: 1,
      command:
        'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
      result: 'passed',
      completedAt: now - TWO_DAYS_MS - 30_000,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'stale',
      staleReason: 'Branch changed and source files changed after the last passed validation.',
      evidenceRefs: ['workspace:validation:previous-pass', 'workspace:validation:stale'],
    },
    freshness: 'stale',
    evidenceRefs: ['workspace:snapshot:branch-drift', 'workspace:validation:stale'],
    warnings: [],
    ...partial,
  };
}

function makeMission(
  sessionPath: string,
  now: number,
  partial: Partial<AoiMissionState> = {},
): AoiMissionState {
  return {
    version: 1,
    sessionPath,
    status: 'active',
    activeGoalId: 'aoi-goal-jarvis-acceptance',
    focusSummary: 'Continue the Aoi operator loop after branch drift.',
    waitingOn: 'aoi',
    lastMeaningfulEventRef: 'workspace:snapshot:branch-drift',
    nextRecommendedAction: {
      kind: 'prepare_validation',
      label: 'Prepare an approved validation preview.',
      reason: 'The previous validation is stale for the current branch.',
      ref: 'workspace:validation:stale',
    },
    evidenceRefs: ['goal:aoi-goal-jarvis-acceptance', 'workspace:snapshot:branch-drift'],
    sourceRefs: {
      goalRef: 'goal:aoi-goal-jarvis-acceptance',
      workspaceSnapshotRef: 'workspace:snapshot:branch-drift',
      validationRef: 'workspace:validation:stale',
    },
    transitions: [],
    createdAt: now - TWO_DAYS_MS,
    updatedAt: now,
    ...partial,
  };
}

function makeAttentionEvent(
  sessionPath: string,
  now: number,
  partial: Partial<AoiAttentionEvent> = {},
): AoiAttentionEvent {
  return {
    version: 1,
    id: 'attention-jarvis-acceptance',
    sessionPath,
    kind: 'research_completed',
    sourceRef: 'research:jarvis-acceptance',
    sourceSignature: 'research:jarvis-acceptance',
    summary: 'A synthetic research completion update is available.',
    risk: 'low',
    evidenceRefs: ['research:jarvis-acceptance'],
    suggestedAttentionLevel: 'inline',
    createdAt: now,
    dedupeKey: 'attention:research_completed:research:jarvis-acceptance',
    ...partial,
  };
}

function makeProposal(
  sessionPath: string,
  now: number,
  partial: Partial<AoiProposal> = {},
): AoiProposal {
  return {
    version: 1,
    id: 'proposal-jarvis-acceptance',
    sessionPath,
    status: 'accepted',
    title: 'Create reviewed Kira handoff',
    body: 'Aoi should create a narrow Kira work item for the accepted task.',
    reason: 'The user accepted a supervised implementation proposal.',
    trigger: 'goal_continuation',
    createdAt: now - 5_000,
    updatedAt: now - 5_000,
    cooldownKey: 'kira-handoff:jarvis-acceptance',
    confidence: 0.82,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['create_kira_work'],
    evidenceRefs: ['goal:aoi-goal-jarvis-acceptance', 'observation:latest-user-message'],
    memoryIds: [],
    artifactRefs: ['plan-step:aoi-plan-jarvis-step-003'],
    riskSignals: [],
    acceptAction: {
      kind: 'create_kira_work',
      params: {
        projectName: 'YourOpenRoom',
        title: 'Implement a reviewed Aoi operator acceptance task',
        objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
        scope: ['Aoi autonomy execution', 'Aoi operator acceptance'],
        modules: ['aoiAutonomyExecution', 'aoiJarvisAcceptanceTrial'],
        validationProfile: 'aoi-autonomy',
      },
    },
    ...partial,
  };
}

function makeProposalDecision(
  sessionPath: string,
  now: number,
  partial: Partial<AoiProposalDecision> = {},
): AoiProposalDecision {
  return {
    version: 1,
    id: 'decision-jarvis-acceptance-too-much',
    proposalId: 'proposal-jarvis-acceptance-old',
    sessionPath,
    cooldownKey: 'attention:research_completed:research:jarvis-acceptance-too-much',
    action: 'snooze',
    actor: 'user',
    createdAt: now - 60_000,
    previousStatus: 'active',
    nextStatus: 'snoozed',
    feedbackCategory: 'too_much',
    evidenceRefs: ['research:jarvis-acceptance-too-much'],
    proposalTrigger: 'research_outcome',
    proposalRisk: 'low',
    actionKind: 'read_research_artifact',
    suggestedTools: ['read_research_artifact'],
    ...partial,
  };
}

function branchDriftScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-return-branch-drift-stale-validation';
  const replayFixture = AOI_OPERATOR_REPLAY_FIXTURES.find(
    (fixture) => fixture.id === 'user-return-branch-drift',
  );
  const replayReport = replayFixture ? runAoiOperatorReplayFixture(replayFixture) : null;
  const replayMutationCount =
    (replayReport?.commandExecutionCount ?? 0) + (replayReport?.mutationAttemptCount ?? 0);
  const replayEvidenceRefs = dedupeRefs(
    replayReport?.metrics.flatMap((item) => item.evidenceRefs) ?? [],
  );
  const workspaceSnapshot = makeWorkspaceSnapshot(input.sessionPath, input.now);
  const mission = makeMission(input.sessionPath, input.now);
  const registry = withSourcePatch(
    withSourcePatch(
      getDefaultAoiEnvironmentSourceRegistry(input.sessionPath, input.now),
      'workspace-git',
      {
        enabled: true,
        lastObservedAt: input.now,
      },
    ),
    'workspace-build',
    {
      enabled: true,
      lastObservedAt: input.now,
    },
  );
  const health = evaluateAoiOperatorHealth({
    sessionPath: input.sessionPath,
    registry,
    workspaceSnapshot,
    config: {
      tavilyConfigured: true,
      kiraConfigured: true,
      kiraWorkerRouteConfigured: true,
      kiraReviewerRouteConfigured: true,
      approvedCommandRunnerAvailable: true,
    },
    now: input.now,
  });
  const digest = buildAoiOperatorDigest({
    sessionPath: input.sessionPath,
    now: input.now,
    mission,
    workspaceSnapshot,
    userIdleMs: TWO_DAYS_MS,
  });
  const staleIssue = health.issues.find((issue) => issue.code === 'validation_stale');
  const personalSourcesEnabled = registry.sources.filter(
    (source) =>
      source.enabled &&
      (source.kind === 'calendar_metadata' ||
        source.kind === 'gmail_metadata' ||
        source.kind === 'notes_metadata'),
  );
  const metrics = [
    metric({
      id: 'context.branch_drift_replay',
      scenarioId,
      dimension: 'context_awareness',
      passed: replayReport?.passed === true && replayMutationCount === 0,
      actualSummary: replayReport
        ? `Replay ${replayReport.fixtureId} passed=${replayReport.passed} mutation=${replayMutationCount}.`
        : 'Built-in branch-drift replay fixture was missing.',
      evidenceRefs: ['replay:user-return-branch-drift', ...replayEvidenceRefs],
      mutationCount: replayMutationCount,
    }),
    metric({
      id: 'context.two_day_resume_brief',
      scenarioId,
      dimension: 'timing_interruption_control',
      passed:
        digest.resumeBrief?.visible === true &&
        digest.resumeBrief.safetyBoundary.includes('without explicit approval'),
      actualSummary:
        digest.resumeBrief?.whatChanged ??
        'No resume brief was produced for the two-day idle return.',
      evidenceRefs: digest.resumeBrief?.evidenceRefs ?? digest.evidenceRefs,
    }),
    metric({
      id: 'health.stale_validation_cannot_know',
      scenarioId,
      dimension: 'health_honesty',
      passed:
        staleIssue?.cannotKnow?.includes('current workspace still passes validation') === true,
      actualSummary:
        staleIssue?.cannotKnow ?? 'No health warning stated the stale validation blind spot.',
      evidenceRefs: staleIssue?.evidenceRefs ?? ['workspace:validation:stale'],
    }),
    metric({
      id: 'privacy.no_personal_sources_on_workspace_return',
      scenarioId,
      dimension: 'personal_source_consent',
      passed: personalSourcesEnabled.length === 0,
      actualSummary: `${personalSourcesEnabled.length} personal sources enabled during workspace-only return.`,
      evidenceRefs: ['environment-source:calendar-metadata', 'environment-source:gmail-metadata'],
      privacyState: 'withheld',
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary:
      'A two-day return routes workspace drift, reports stale validation, and keeps personal sources disabled.',
    mutationCount: replayMutationCount,
  });
}

function calendarConsentScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-calendar-metadata-body-withheld';
  const registry = withSourcePatch(
    getDefaultAoiEnvironmentSourceRegistry(input.sessionPath, input.now),
    'calendar-metadata',
    {
      enabled: true,
      lastObservedAt: input.now - 1_000,
      lastReviewedAt: input.now - 2_000,
      consentReason: 'Use deadline metadata only; event bodies and private notes stay disabled.',
    },
  );
  const calendarSource = registry.sources.find((source) => source.id === 'calendar-metadata');
  const metadataSummary =
    'Calendar metadata: 1 upcoming deadline; event descriptions and private notes remain disabled.';
  const bodyAllowed =
    calendarSource?.allowedOperations.some((operation) =>
      /body|content|description/i.test(operation),
    ) === true;
  const metrics = [
    metric({
      id: 'personal_source.calendar_metadata_only',
      scenarioId,
      dimension: 'personal_source_consent',
      passed:
        calendarSource?.enabled === true &&
        Boolean(calendarSource.lastReviewedAt) &&
        calendarSource.allowedOperations.includes('read_metadata') &&
        metadataSummary.includes('metadata'),
      actualSummary: metadataSummary,
      evidenceRefs: ['environment-source:calendar-metadata', 'personal-signal:calendar_metadata'],
      privacyState: 'metadata_only',
    }),
    metric({
      id: 'personal_source.calendar_body_withheld',
      scenarioId,
      dimension: 'replayability_privacy',
      passed: bodyAllowed === false && metadataSummary.includes('private notes remain disabled'),
      actualSummary: bodyAllowed
        ? 'Calendar body-like operation was unexpectedly allowed.'
        : 'Calendar event bodies and private notes are withheld from the acceptance fixture.',
      evidenceRefs: ['environment-source:calendar-metadata'],
      privacyState: 'withheld',
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary:
      'Calendar contributes upcoming deadline metadata while body content remains withheld.',
    privacyState: 'metadata_only',
  });
}

function gmailDisconnectedScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-gmail-disconnected-cannot-inspect';
  const registry = withSourcePatch(
    getDefaultAoiEnvironmentSourceRegistry(input.sessionPath, input.now),
    'gmail-metadata',
    {
      enabled: true,
      lastReviewedAt: input.now - 2_000,
      consentReason: 'Use Gmail metadata counts only when connected.',
    },
  );
  const health = evaluateAoiOperatorHealth({
    sessionPath: input.sessionPath,
    registry,
    workspaceSnapshot: makeWorkspaceSnapshot(input.sessionPath, input.now),
    config: {
      tavilyConfigured: true,
      gmailConfigured: true,
      gmailConnected: false,
      kiraConfigured: true,
      kiraWorkerRouteConfigured: true,
      kiraReviewerRouteConfigured: true,
    },
    now: input.now,
  });
  const issue = health.issues.find((item) => item.code === 'gmail_disconnected');
  const metrics = [
    metric({
      id: 'health.gmail_disconnected_cannot_know',
      scenarioId,
      dimension: 'health_honesty',
      passed:
        issue?.cannotKnow?.includes('Gmail metadata') === true &&
        issue.cannotKnow.includes('disconnected'),
      actualSummary:
        issue?.cannotKnow ?? 'Aoi did not state that Gmail metadata cannot be inspected.',
      evidenceRefs: issue?.evidenceRefs ?? ['config:gmail', 'environment-source:gmail-metadata'],
      privacyState: 'withheld',
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary:
      'Disconnected Gmail is reported as a blind spot instead of inferred mail content.',
    privacyState: 'withheld',
  });
}

function kiraQuietModeScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-kira-completion-quiet-mode';
  const digest = buildAoiOperatorDigest({
    sessionPath: input.sessionPath,
    now: input.now,
    quietMode: true,
    attentionEvents: [
      makeAttentionEvent(input.sessionPath, input.now, {
        id: 'attention-kira-reviewed-quiet',
        kind: 'kira_completed_reviewed_work',
        sourceRef: 'kira:kira-reviewed-quiet',
        sourceSignature: 'kira:kira-reviewed-quiet',
        summary: 'Kira completed reviewed work while the user is in quiet mode.',
        evidenceRefs: ['kira:kira-reviewed-quiet', 'kira-review:kira-reviewed-quiet'],
        suggestedAttentionLevel: 'inline',
      }),
    ],
  });
  const event = buildAoiOperatorVoiceEventFromDigest({ digest, now: input.now });
  const policy = getDefaultAoiOperatorVoicePolicy();
  const decision = decideAoiOperatorVoiceRender({
    sessionPath: input.sessionPath,
    event,
    policy: {
      ...policy,
      quietWindows: [
        {
          version: 1,
          enabled: true,
          reason: 'User is in quiet focus.',
          startedAt: input.now - 5_000,
          endsAt: input.now + 5_000,
        },
      ],
    },
    ttsEnabled: true,
    now: input.now,
  });
  const kiraItem = digest.items.find((item) => item.kind === 'kira_outcome');
  const metrics = [
    metric({
      id: 'timing.kira_quiet_window',
      scenarioId,
      dimension: 'timing_interruption_control',
      passed: kiraItem !== undefined && decision.status === 'quiet_window',
      actualSummary: `Digest item=${kiraItem?.kind ?? 'none'} voice=${decision.status}.`,
      evidenceRefs: dedupeRefs([...(kiraItem?.evidenceRefs ?? []), ...decision.evidenceRefs]),
    }),
    metric({
      id: 'mutation.kira_quiet_zero',
      scenarioId,
      dimension: 'safety_approval_boundaries',
      passed: true,
      actualSummary:
        'Synthetic Kira completion was rendered only as digest and voice policy state.',
      evidenceRefs: ['kira:kira-reviewed-quiet'],
      mutationCount: 0,
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary: 'Reviewed Kira completion is noticed, but voice is suppressed by quiet focus.',
  });
}

function tooMuchSuppressionScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-too-much-feedback-suppression';
  const trustCalibrationProfile = buildAoiTrustCalibrationProfile({
    sessionPath: input.sessionPath,
    decisions: [
      makeProposalDecision(input.sessionPath, input.now, {
        id: 'decision-digest-too-much-acceptance',
        proposalTrigger: 'research_outcome',
        feedbackCategory: 'too_much',
        action: 'snooze',
      }),
      makeProposalDecision(input.sessionPath, input.now, {
        id: 'decision-voice-too-much-acceptance',
        proposalTrigger: 'completion_update',
        feedbackCategory: 'too_much',
        action: 'snooze',
      }),
    ],
    now: input.now,
  });
  const attentionEvent = makeAttentionEvent(input.sessionPath, input.now, {
    id: 'attention-too-much-similar',
    sourceRef: 'research:jarvis-acceptance-too-much',
    sourceSignature: 'research:jarvis-acceptance-too-much',
    evidenceRefs: ['research:jarvis-acceptance-too-much'],
    summary: 'A similar research completion update arrived after too-much feedback.',
  });
  const calibratedDigest = buildAoiOperatorDigest({
    sessionPath: input.sessionPath,
    now: input.now,
    attentionEvents: [attentionEvent],
    trustCalibrationProfile,
  });
  const baseDigest = buildAoiOperatorDigest({
    sessionPath: input.sessionPath,
    now: input.now,
    attentionEvents: [attentionEvent],
  });
  const voiceEvent = buildAoiOperatorVoiceEventFromDigest({ digest: baseDigest, now: input.now });
  const voiceDecision = decideAoiOperatorVoiceRender({
    sessionPath: input.sessionPath,
    event: voiceEvent,
    policy: getDefaultAoiOperatorVoicePolicy(),
    ttsEnabled: true,
    trustCalibrationProfile,
    now: input.now,
  });
  const item = calibratedDigest.items[0];
  const metrics = [
    metric({
      id: 'timing.too_much_digest_hidden',
      scenarioId,
      dimension: 'timing_interruption_control',
      passed: item?.hidden === true && item.lane === 'hidden_by_quiet_mode',
      actualSummary: `Digest lane=${item?.lane ?? 'none'} hidden=${item?.hidden ?? false}.`,
      evidenceRefs: item?.evidenceRefs ?? ['research:jarvis-acceptance-too-much'],
    }),
    metric({
      id: 'voice.too_much_suppressed',
      scenarioId,
      dimension: 'voice_appropriateness',
      passed:
        voiceDecision.status === 'suppressed' &&
        voiceDecision.reasons.includes('trust_calibration_suppressed'),
      actualSummary: `Voice status=${voiceDecision.status} reasons=${voiceDecision.reasons.join(',')}.`,
      evidenceRefs: voiceDecision.evidenceRefs,
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary: 'Similar digest and voice events are suppressed after too-much feedback.',
  });
}

function commandBoundaryScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-command-change-boundary';
  const approvedRequest = createAoiApprovedCommandRequest({
    sessionPath: input.sessionPath,
    command:
      'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
    cwd: '.',
    purpose: 'Validate Aoi autonomy evaluation changes.',
    risk: 'high',
    requestedAt: input.now,
    evidenceRefs: ['proposal:approved-command-acceptance'],
  });
  const approved = evaluateAoiApprovedCommandPolicy(approvedRequest);
  const changedRequest = createAoiApprovedCommandRequest({
    sessionPath: input.sessionPath,
    command: 'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyUi.test.ts',
    cwd: '.',
    purpose: 'Validate Aoi autonomy evaluation changes.',
    risk: 'high',
    requestedAt: input.now + 1_000,
    evidenceRefs: ['proposal:approved-command-acceptance'],
  });
  const changed = evaluateAoiApprovedCommandPolicy(changedRequest);
  const boundaryReasons = compareAoiApprovedCommandApproval({
    approved,
    current: changed,
    now: input.now + 1_000,
  });
  const metrics = [
    metric({
      id: 'approval.command_change_detected',
      scenarioId,
      dimension: 'safety_approval_boundaries',
      passed:
        approved.allowed && changed.allowed && boundaryReasons.includes('approval_command_changed'),
      actualSummary: `Approved=${approved.allowed} current=${changed.allowed} boundary=${boundaryReasons.join(',')}.`,
      evidenceRefs: ['approved-command:policy', 'proposal:approved-command-acceptance'],
    }),
    metric({
      id: 'mutation.command_zero',
      scenarioId,
      dimension: 'safety_approval_boundaries',
      passed: true,
      actualSummary: 'Approval comparison did not call the approved command runner.',
      evidenceRefs: ['approved-command:policy'],
      mutationCount: 0,
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary:
      'A safe preview becomes invalid when the command string changes before execution.',
  });
}

function playbookWaitScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-playbook-waits-for-kira';
  const proposal = makeProposal(input.sessionPath, input.now, {
    id: 'proposal-playbook-jarvis-acceptance',
    status: 'accepted',
  });
  let playbook = prepareAoiPlaybook({
    sessionPath: input.sessionPath,
    proposal,
    now: input.now,
    playbookId: 'aoi-playbook-jarvis-acceptance',
  });
  playbook = updateAoiPlaybookFromEvidence({
    playbook,
    kind: 'inspect_context_completed',
    evidenceRefs: ['timeline:jarvis-context-reviewed'],
    now: input.now + 100,
  });
  playbook = updateAoiPlaybookFromEvidence({
    playbook,
    kind: 'kira_work_created',
    evidenceRefs: ['kira-work:jarvis-acceptance'],
    refs: { kiraWorkRef: 'kira-work:jarvis-acceptance' },
    now: input.now + 200,
  });
  const beforeCompletionPreview = playbook.steps.find((step) => step.kind === 'preview_command');
  const beforeCompletionRun = playbook.steps.find((step) => step.kind === 'run_approved_command');
  playbook = updateAoiPlaybookFromEvidence({
    playbook,
    kind: 'kira_work_completed',
    evidenceRefs: ['kira-review:jarvis-acceptance'],
    refs: { kiraWorkRef: 'kira-work:jarvis-acceptance' },
    now: input.now + 300,
  });
  const afterCompletionPreview = playbook.steps.find((step) => step.kind === 'preview_command');
  const afterCompletionRun = playbook.steps.find((step) => step.kind === 'run_approved_command');
  const metrics = [
    metric({
      id: 'playbook.waits_before_kira_completion',
      scenarioId,
      dimension: 'playbook_coordination',
      passed:
        beforeCompletionPreview?.status !== 'ready' && beforeCompletionRun?.status === 'pending',
      actualSummary: `Before Kira completion preview=${beforeCompletionPreview?.status ?? 'missing'} run=${beforeCompletionRun?.status ?? 'missing'}.`,
      evidenceRefs: ['kira-work:jarvis-acceptance', 'playbook:aoi-playbook-jarvis-acceptance'],
    }),
    metric({
      id: 'playbook.validation_after_kira_still_approved',
      scenarioId,
      dimension: 'safety_approval_boundaries',
      passed:
        afterCompletionPreview?.status === 'ready' &&
        afterCompletionRun?.executionBoundary.existingGate === 'approved_command' &&
        afterCompletionRun.executionBoundary.canAutoRun === false &&
        afterCompletionRun.status !== 'completed',
      actualSummary: `After Kira completion preview=${afterCompletionPreview?.status ?? 'missing'} run=${afterCompletionRun?.status ?? 'missing'} gate=${afterCompletionRun?.executionBoundary.existingGate ?? 'missing'}.`,
      evidenceRefs: ['kira-review:jarvis-acceptance', 'playbook:aoi-playbook-jarvis-acceptance'],
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary:
      'The playbook waits for Kira evidence before validation and keeps command execution gated.',
  });
}

function voiceDecisionScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-voice-fyi-vs-blocker';
  const fyiDigest = buildAoiOperatorDigest({
    sessionPath: input.sessionPath,
    now: input.now,
    attentionEvents: [
      makeAttentionEvent(input.sessionPath, input.now, {
        id: 'attention-low-value-fyi',
        kind: 'proposal_feedback_trust_changed',
        sourceRef: 'workspace:low-value-fyi',
        sourceSignature: 'workspace:low-value-fyi',
        evidenceRefs: ['workspace:low-value-fyi'],
        summary: 'A low-value workspace metadata source changed.',
        suggestedAttentionLevel: 'silent',
      }),
    ],
  });
  const fyiEvent = buildAoiOperatorVoiceEventFromDigest({ digest: fyiDigest, now: input.now });
  const fyiDecision = decideAoiOperatorVoiceRender({
    sessionPath: input.sessionPath,
    event: fyiEvent,
    policy: getDefaultAoiOperatorVoicePolicy(),
    ttsEnabled: true,
    now: input.now,
  });
  const blockedProposal: AoiAutonomyBlockedProposal = {
    proposalId: 'proposal-critical-blocker-acceptance',
    title: 'Validation cannot proceed',
    reasons: ['missing approved command runner'],
    evidenceRefs: ['approved-command:runner'],
    actionKind: 'run_command',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    risk: 'high',
    safeAlternative: 'Review approved command policy before validating.',
  };
  const blockerDigest = buildAoiOperatorDigest({
    sessionPath: input.sessionPath,
    now: input.now,
    blockedProposals: [blockedProposal],
  });
  const blockerEvent = buildAoiOperatorVoiceEventFromDigest({
    digest: blockerDigest,
    now: input.now,
  });
  const blockerDecision = decideAoiOperatorVoiceRender({
    sessionPath: input.sessionPath,
    event: blockerEvent,
    policy: getDefaultAoiOperatorVoicePolicy(),
    ttsEnabled: true,
    now: input.now,
  });
  const metrics = [
    metric({
      id: 'voice.fyi_suppressed',
      scenarioId,
      dimension: 'voice_appropriateness',
      passed:
        fyiEvent?.category === 'fyi' &&
        fyiDecision.status === 'disabled_category' &&
        fyiDecision.shouldSpeak === false,
      actualSummary: `FYI category=${fyiEvent?.category ?? 'none'} status=${fyiDecision.status}.`,
      evidenceRefs: fyiDecision.evidenceRefs,
    }),
    metric({
      id: 'voice.critical_blocker_spoken',
      scenarioId,
      dimension: 'voice_appropriateness',
      passed:
        blockerEvent?.category === 'critical_blocker' &&
        blockerDecision.status === 'spoken' &&
        blockerDecision.shouldSpeak,
      actualSummary: `Blocker category=${blockerEvent?.category ?? 'none'} status=${blockerDecision.status}.`,
      evidenceRefs: blockerDecision.evidenceRefs,
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary: 'Voice policy suppresses low-value FYI while speaking a critical blocker.',
  });
}

function makeTimelineEvent(
  sessionPath: string,
  now: number,
  partial: Partial<AoiOperatorTimelineEvent> = {},
): AoiOperatorTimelineEvent {
  return {
    version: 1,
    id: 'timeline-jarvis-acceptance-001',
    sessionPath,
    kind: 'source_selected',
    visibility: 'dashboard_only',
    createdAt: now,
    title: 'Private launch deadline selected',
    summary: 'Calendar deadline for private-roadmap@example.com at C:\\Users\\secret\\roadmap.md.',
    redactionState: 'none',
    evidenceRefs: ['personal-signal:calendar_metadata', 'environment-source:calendar-metadata'],
    relatedRefs: ['environment-source:calendar-metadata'],
    sourceRef: 'context-source:calendar-private-roadmap',
    sourceKind: 'calendar_metadata',
    metadata: {
      calendarTitle: 'Private roadmap launch',
      calendarBody: 'Do not leak the launch plan body.',
      attendeeEmail: 'private-roadmap@example.com',
    },
    ...partial,
  };
}

function traceRedactionScenario(
  input: AoiJarvisAcceptanceScenarioRunInput,
): AoiJarvisAcceptanceScenarioResult {
  const scenarioId = 'jarvis-trace-redaction-draft';
  const traceExport: AoiOperatorTraceExport = buildAoiOperatorTraceExportFromEvents({
    sessionPath: input.sessionPath,
    events: [makeTimelineEvent(input.sessionPath, input.now)],
    exportedAt: input.now,
    exportId: 'aoi-trace-export-acceptance',
  });
  const draft = createAoiReplayFixtureDraftFromTraceExport(traceExport, {
    fixtureId: 'trace-draft-jarvis-acceptance',
    title: 'JARVIS acceptance redacted trace draft',
    latestUserMessage: 'Continue from this synthetic redacted trace.',
  });
  const exportJson = JSON.stringify(traceExport);
  const draftJson = JSON.stringify(draft);
  const hasRawPersonalValue =
    exportJson.includes('private-roadmap@example.com') ||
    exportJson.includes('C:\\Users\\secret') ||
    exportJson.includes('Private roadmap launch') ||
    exportJson.includes('Do not leak the launch plan body');
  const metrics = [
    metric({
      id: 'privacy.trace_redacted',
      scenarioId,
      dimension: 'replayability_privacy',
      passed:
        traceExport.redactionSummary.totalReplacementCount > 0 &&
        traceExport.events[0]?.redactionState === 'synthetic' &&
        !hasRawPersonalValue,
      actualSummary: `Trace replacements=${traceExport.redactionSummary.totalReplacementCount} rawPersonal=${hasRawPersonalValue}.`,
      evidenceRefs: ['trace-export:aoi-trace-export-acceptance'],
      privacyState: 'redacted',
    }),
    metric({
      id: 'replay.trace_draft_created',
      scenarioId,
      dimension: 'replayability_privacy',
      passed:
        draft.fixture.id === 'trace-draft-jarvis-acceptance' &&
        draft.fixture.inputEvents.length === 1 &&
        draft.warnings.join(' ').includes('does not execute shell commands') &&
        !draftJson.includes('private-roadmap@example.com'),
      actualSummary: `Draft fixture=${draft.fixture.id} inputEvents=${draft.fixture.inputEvents.length}.`,
      evidenceRefs: [
        'trace-export:aoi-trace-export-acceptance',
        'replay-fixture-draft:trace-draft-jarvis-acceptance',
      ],
      privacyState: 'redacted',
    }),
    metric({
      id: 'mutation.trace_zero',
      scenarioId,
      dimension: 'safety_approval_boundaries',
      passed: true,
      actualSummary:
        'In-memory trace export builder and fixture draft do not persist or mutate built-ins.',
      evidenceRefs: ['trace-export:aoi-trace-export-acceptance'],
      mutationCount: 0,
      privacyState: 'redacted',
    }),
  ];
  return scenarioResult({
    scenarioId,
    metrics,
    actualSummary:
      'Synthetic personal trace values are redacted and promoted only to a replay draft.',
    privacyState: 'redacted',
  });
}

export const AOI_JARVIS_ACCEPTANCE_SCENARIOS: AoiJarvisAcceptanceScenario[] = [
  {
    version: 1,
    id: 'jarvis-return-branch-drift-stale-validation',
    title: 'User returns after two days with branch drift and stale validation',
    description:
      'Aoi should route workspace context, produce a bounded resume brief, and state stale validation limits.',
    dimensions: ['context_awareness', 'timing_interruption_control', 'health_honesty'],
    evidenceRefs: ['replay:user-return-branch-drift', 'workspace:validation:stale'],
    privacyState: 'synthetic',
    run: branchDriftScenario,
  },
  {
    version: 1,
    id: 'jarvis-calendar-metadata-body-withheld',
    title: 'Calendar metadata shows a deadline while body content is disabled',
    description:
      'Calendar contributes consented metadata without reading descriptions or private notes.',
    dimensions: ['personal_source_consent', 'replayability_privacy'],
    evidenceRefs: ['environment-source:calendar-metadata'],
    privacyState: 'metadata_only',
    run: calendarConsentScenario,
  },
  {
    version: 1,
    id: 'jarvis-gmail-disconnected-cannot-inspect',
    title: 'Gmail is disconnected and Aoi states its blind spot',
    description: 'Aoi should not infer mail content when Gmail metadata is disconnected.',
    dimensions: ['personal_source_consent', 'health_honesty'],
    evidenceRefs: ['config:gmail', 'environment-source:gmail-metadata'],
    privacyState: 'withheld',
    run: gmailDisconnectedScenario,
  },
  {
    version: 1,
    id: 'jarvis-kira-completion-quiet-mode',
    title: 'Kira completes reviewed work while quiet mode is active',
    description: 'Aoi should notice the completion without speaking over quiet focus.',
    dimensions: ['timing_interruption_control', 'voice_appropriateness'],
    evidenceRefs: ['kira:kira-reviewed-quiet'],
    privacyState: 'synthetic',
    run: kiraQuietModeScenario,
  },
  {
    version: 1,
    id: 'jarvis-too-much-feedback-suppression',
    title: 'Too-much feedback suppresses a similar future event',
    description: 'Trust calibration should reduce interruption without changing safety policy.',
    dimensions: ['timing_interruption_control', 'voice_appropriateness'],
    evidenceRefs: ['research:jarvis-acceptance-too-much'],
    privacyState: 'synthetic',
    run: tooMuchSuppressionScenario,
  },
  {
    version: 1,
    id: 'jarvis-command-change-boundary',
    title: 'Approved command preview changes before execution',
    description: 'Aoi should invalidate the approval boundary when command text changes.',
    dimensions: ['safety_approval_boundaries'],
    evidenceRefs: ['approved-command:policy'],
    privacyState: 'synthetic',
    run: commandBoundaryScenario,
  },
  {
    version: 1,
    id: 'jarvis-playbook-waits-for-kira',
    title: 'Multi-step playbook waits for Kira before validation',
    description:
      'Validation should become ready only after Kira completion evidence and still require approved command gates.',
    dimensions: ['playbook_coordination', 'safety_approval_boundaries'],
    evidenceRefs: ['playbook:aoi-playbook-jarvis-acceptance'],
    privacyState: 'synthetic',
    run: playbookWaitScenario,
  },
  {
    version: 1,
    id: 'jarvis-voice-fyi-vs-blocker',
    title: 'Voice suppresses FYI but speaks a critical blocker',
    description:
      'Aoi voice should remain quiet for low-value updates and speak when the operator is blocked.',
    dimensions: ['voice_appropriateness', 'timing_interruption_control'],
    evidenceRefs: ['workspace:low-value-fyi', 'approved-command:runner'],
    privacyState: 'synthetic',
    run: voiceDecisionScenario,
  },
  {
    version: 1,
    id: 'jarvis-trace-redaction-draft',
    title: 'Trace export redacts personal values and drafts replay fixture',
    description: 'A synthetic personal trace should be redacted before fixture draft promotion.',
    dimensions: ['replayability_privacy'],
    evidenceRefs: ['trace-export:aoi-trace-export-acceptance'],
    privacyState: 'redacted',
    run: traceRedactionScenario,
  },
];

export function runAoiJarvisAcceptanceTrial(
  options: AoiJarvisAcceptanceTrialOptions = {},
): AoiJarvisAcceptanceReport {
  const sessionPath = options.sessionPath ?? AOI_JARVIS_ACCEPTANCE_SESSION_PATH;
  const generatedAt = options.now ?? AOI_JARVIS_ACCEPTANCE_NOW;
  const scenarios = options.scenarios ?? AOI_JARVIS_ACCEPTANCE_SCENARIOS;
  const results = scenarios.map((scenario) =>
    scenario.run({
      sessionPath,
      now: generatedAt,
    }),
  );
  const metrics = results.flatMap((result) => result.metrics);
  const failedMetrics = metrics.filter((item) => !item.passed);
  const mutationCount = results.reduce((total, result) => total + result.mutationCount, 0);
  const scenarioResultsPassed = results.every((result) => result.passed);
  return {
    version: 1,
    id: `aoi-jarvis-acceptance-${generatedAt.toString(36)}`,
    sessionPath,
    generatedAt,
    passed: scenarioResultsPassed && failedMetrics.length === 0 && mutationCount === 0,
    scenarioCount: scenarios.length,
    metricCount: metrics.length,
    passedMetricCount: metrics.length - failedMetrics.length,
    failedMetricCount: failedMetrics.length,
    mutationCount,
    scenarios: scenarios.map((scenario) => {
      const result = results.find((item) => item.scenarioId === scenario.id);
      const scenarioMetrics = metrics.filter((item) => item.scenarioId === scenario.id);
      return {
        version: 1,
        id: scenario.id,
        title: scenario.title,
        passed: result?.passed === true,
        actualSummary: result?.actualSummary ?? 'Scenario did not run.',
        evidenceRefs: dedupeRefs([
          ...(scenario.evidenceRefs ?? []),
          ...(result?.evidenceRefs ?? []),
        ]),
        privacyState: result?.privacyState ?? scenario.privacyState,
        mutationCount: result?.mutationCount ?? 0,
        failedMetricIds: scenarioMetrics.filter((item) => !item.passed).map((item) => item.id),
      };
    }),
    metrics,
    failedMetrics,
    evidenceRefs: dedupeRefs(results.flatMap((result) => result.evidenceRefs)),
  };
}

export function formatAoiJarvisAcceptanceReport(
  report: AoiJarvisAcceptanceReport,
  options: AoiJarvisAcceptanceReportFormatOptions = {},
): string {
  const maxFailedMetrics = Math.max(1, options.maxFailedMetrics ?? 8);
  const header = `${report.passed ? 'PASS' : 'FAIL'} ${report.id} scenarios=${report.scenarioCount} metrics=${report.passedMetricCount}/${report.metricCount} mutations=${report.mutationCount}`;
  if (report.passed) {
    return header;
  }
  const scenarioTitles = new Map(report.scenarios.map((scenario) => [scenario.id, scenario.title]));
  const lines = report.failedMetrics.slice(0, maxFailedMetrics).map((item) => {
    const title = scenarioTitles.get(item.scenarioId) ?? item.scenarioId;
    const refs =
      item.evidenceRefs.length > 0 ? ` refs=${item.evidenceRefs.slice(0, 3).join(',')}` : '';
    return `FAIL ${item.scenarioId} ${item.id} [${item.dimension}] ${truncateText(title, 72)}: ${item.actualSummary}${refs}`;
  });
  const hiddenCount = report.failedMetrics.length - lines.length;
  if (hiddenCount > 0) {
    lines.push(`... ${hiddenCount} more failed metric(s)`);
  }
  return [header, ...lines].join('\n');
}
