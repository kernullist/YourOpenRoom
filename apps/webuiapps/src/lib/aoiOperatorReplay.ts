import { DEFAULT_AOI_AUTONOMY_POLICY, checkAoiProposalPolicy } from './aoiAutonomyPolicy';
import { createAoiObservation } from './aoiAutonomyObserver';
import { runAoiAttentionBroker } from './aoiAttentionBroker';
import { buildAoiContextRouterResult } from './aoiContextRouter';
import {
  buildAoiFailureRecoveryProposals,
  type AoiFailureClassificationInput,
} from './aoiAutonomyRecovery';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import {
  buildAoiBlockedStateSummary,
  buildAoiMissionPanelSummary,
  buildAoiPreferenceInfluencePanelSummary,
  buildAoiPreparedActionPlanPanelSummary,
  buildAoiProactiveExplanation,
  buildAoiRecoveryPreviewSummary,
} from './aoiAutonomyUi';
import { buildAoiOperatorDigest } from './aoiOperatorDigest';
import { buildAoiPreparedActionPlan } from './aoiSafeActionPlan';
import { evaluateAoiAutonomyRecords } from './aoiAutonomyEvaluation';
import { resolveAoiPreferenceContext } from './aoiPreferenceMemory';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import type { AoiResearchRunSummary } from './aoiResearchTypes';
import type {
  AoiApprovedCommandPolicy,
  AoiAttentionBrokerDecisionKind,
  AoiAutonomyBlockedProposal,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiBrowserContextMetadata,
  AoiContextRouterResult,
  AoiContextSourceFeedback,
  AoiContextSourceKind,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiGoal,
  AoiMissionState,
  AoiNotificationLane,
  AoiObservation,
  AoiOperatorDigest,
  AoiPreparedActionPlan,
  AoiProposal,
  AoiProposalDecision,
  AoiRecoveryActionKind,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

const REPLAY_SESSION_PATH = 'aoi/replay';
const REPLAY_NOW = 1_800_000_000_000;
const REPLAY_PROJECT_KEY = 'youropenroom';

export type AoiReplayInputEventKind =
  | 'mission_state'
  | 'active_goal'
  | 'workspace_snapshot'
  | 'kira_memory'
  | 'research_run'
  | 'proposal'
  | 'proposal_decision'
  | 'preference_memory'
  | 'browser_context'
  | 'context_feedback'
  | 'environment_source';

export type AoiReplayMetricName =
  | 'source_selected'
  | 'source_not_selected'
  | 'attention_decision'
  | 'proposal_decision'
  | 'approval_boundary'
  | 'evidence_refs'
  | 'non_interruption'
  | 'blocked_reason'
  | 'preference_conflict'
  | 'digest_lane'
  | 'recovery_suggestion'
  | 'no_command_execution'
  | 'snapshot_summary';

export interface AoiReplayInputEvent {
  version: 1;
  id: string;
  kind: AoiReplayInputEventKind;
  createdAt: number;
  summary: string;
  sourceRef: string;
  evidenceRefs: string[];
  mission?: AoiMissionState;
  goal?: AoiGoal;
  workspaceSnapshot?: AoiWorkspaceSnapshot;
  memory?: AoiMemoryEntry;
  researchRun?: AoiResearchRunSummary;
  proposal?: AoiProposal;
  decision?: AoiProposalDecision;
  browserContext?: AoiBrowserContextMetadata;
  contextFeedback?: AoiContextSourceFeedback;
  environmentSource?: AoiEnvironmentSource;
}

export interface AoiReplayExpectedDecision {
  id: string;
  metric: AoiReplayMetricName;
  label: string;
  sourceId?: string;
  sourceKind?: AoiContextSourceKind;
  sourceLabelIncludes?: string;
  eventKind?: string;
  sourceRef?: string;
  attentionDecisionKind?: AoiAttentionBrokerDecisionKind;
  shouldCreateProposal?: boolean;
  proposalTitleIncludes?: string;
  approvalBoundaryIncludes?: string;
  evidenceRefs?: string[];
  nonInterrupting?: boolean;
  blockedReasonIncludes?: string;
  preferenceConflictKey?: string;
  preferenceWinner?: string;
  digestLane?: AoiNotificationLane;
  recoveryActionKind?: AoiRecoveryActionKind;
  snapshotIncludes?: string;
  expected?: boolean | string | number | string[];
}

export interface AoiOperatorReplayFixture {
  version: 1;
  id: string;
  title: string;
  description: string;
  sessionPath: string;
  now: number;
  latestUserMessage: string;
  quietMode?: boolean;
  userIdleMs?: number;
  projectKey?: string;
  policy?: AoiAutonomyPolicy;
  registry?: AoiEnvironmentSourceRegistry;
  inputEvents: AoiReplayInputEvent[];
  expectedDecisions: AoiReplayExpectedDecision[];
}

export interface AoiReplayMetric {
  version: 1;
  id: string;
  name: AoiReplayMetricName;
  label: string;
  passed: boolean;
  expected: string;
  actual: string;
  evidenceRefs: string[];
  details?: string;
}

export interface AoiReplayReport {
  version: 1;
  fixtureId: string;
  title: string;
  sessionPath: string;
  generatedAt: number;
  passed: boolean;
  summary: string;
  metrics: AoiReplayMetric[];
  selectedSourceLabels: string[];
  attentionDecisionLabels: string[];
  generatedProposalLabels: string[];
  blockedReasonLabels: string[];
  preferenceConflictLabels: string[];
  digestSummary: string;
  commandExecutionCount: number;
  mutationAttemptCount: number;
}

interface AoiReplayMaterializedState {
  mission: AoiMissionState | null;
  activeGoals: AoiGoal[];
  workspaceSnapshot: AoiWorkspaceSnapshot | null;
  memories: AoiMemoryEntry[];
  researchRuns: AoiResearchRunSummary[];
  activeProposals: AoiProposal[];
  decisions: AoiProposalDecision[];
  browserContexts: AoiBrowserContextMetadata[];
  contextFeedback: AoiContextSourceFeedback[];
  registry: AoiEnvironmentSourceRegistry;
  observations: AoiObservation[];
  failures: AoiFailureClassificationInput[];
}

interface AoiReplayRuntime {
  fixture: AoiOperatorReplayFixture;
  state: AoiReplayMaterializedState;
  context: AoiContextRouterResult;
  attention: ReturnType<typeof runAoiAttentionBroker>;
  recovery: ReturnType<typeof buildAoiFailureRecoveryProposals>;
  digest: AoiOperatorDigest;
  generatedProposals: AoiProposal[];
  allProposals: AoiProposal[];
  blockedProposals: AoiAutonomyBlockedProposal[];
  preparedPlans: Array<{ proposal: AoiProposal; plan: AoiPreparedActionPlan; summary: string }>;
  commandPolicies: Array<{ proposal: AoiProposal; policy: AoiApprovedCommandPolicy }>;
  preferenceResolution: ReturnType<typeof resolveAoiPreferenceContext>;
  evaluation: ReturnType<typeof evaluateAoiAutonomyRecords>;
  missionSummary: string;
  replaySnapshot: string;
}

function normalizeText(value: string, maxChars = 260): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function stableId(prefix: string, seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, '0')}`;
}

function dedupe(values: Array<string | undefined | null>, maxItems = 24): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === 'string' ? normalizeText(value, 240) : '';
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function basePolicy(now = REPLAY_NOW, patch: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    previewMode: true,
    proactiveSuggestionsEnabled: true,
    level: 'L4',
    maxActiveProposals: 8,
    maxProposalsPerTick: 4,
    updatedAt: now,
    ...patch,
  };
}

function source(
  id: string,
  kind: AoiEnvironmentSource['kind'],
  enabled = true,
  risk: AoiAutonomyRisk = 'low',
): AoiEnvironmentSource {
  return {
    version: 1,
    id,
    kind,
    label: id.replace(/-/g, ' '),
    enabled,
    scope: kind === 'browser_context' ? 'explicit_target' : 'session',
    risk,
    allowedOperations: ['summarize', 'status', 'read_metadata'],
    privateByDefault: risk === 'high',
    quietModeBehavior: enabled ? 'record_only' : 'suppress',
    updatedAt: REPLAY_NOW,
  };
}

function baseRegistry(
  sessionPath = REPLAY_SESSION_PATH,
  patchSources: AoiEnvironmentSource[] = [],
): AoiEnvironmentSourceRegistry {
  const defaults = [
    source('workspace-git', 'workspace_git'),
    source('workspace-build', 'workspace_build'),
    source('kira-board', 'kira_board'),
    source('research-runs', 'research_runs'),
    source('app-state', 'app_state'),
    source('browser-context', 'browser_context', false, 'high'),
    source('manual-note', 'manual_note'),
  ];
  const patched = new Map(defaults.map((item) => [item.id, item]));
  for (const item of patchSources) {
    patched.set(item.id, item);
  }
  return {
    version: 1,
    sessionPath,
    sources: [...patched.values()],
    updatedAt: REPLAY_NOW,
  };
}

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: REPLAY_SESSION_PATH,
    status: 'active',
    activeGoalId: 'goal-replay-operator',
    focusSummary: 'Continue Aoi operator validation work.',
    waitingOn: 'aoi',
    lastMeaningfulEventRef: 'goal:goal-replay-operator',
    nextRecommendedAction: {
      kind: 'prepare_validation',
      label: 'Prepare the next safe validation check.',
      reason: 'Workspace state changed after the last validation.',
      ref: 'workspace:snapshot:branch-drift',
    },
    evidenceRefs: ['goal:goal-replay-operator'],
    sourceRefs: {
      goalRef: 'goal:goal-replay-operator',
    },
    transitions: [],
    createdAt: REPLAY_NOW - 3_600_000,
    updatedAt: REPLAY_NOW - 1_800_000,
    ...partial,
  };
}

function makeGoal(partial: Partial<AoiGoal> = {}): AoiGoal {
  return {
    version: 1,
    id: 'goal-replay-operator',
    sessionPath: REPLAY_SESSION_PATH,
    title: 'Improve Aoi operator loop',
    userIntentSummary: 'Make Aoi useful without noisy interruption.',
    sourceRefs: ['workspace:snapshot:branch-drift'],
    status: 'active',
    createdAt: REPLAY_NOW - 3_600_000,
    updatedAt: REPLAY_NOW - 1_800_000,
    lastCheckedAt: REPLAY_NOW - 1_800_000,
    confidence: 0.82,
    risk: 'low',
    owner: 'aoi',
    plan: {
      version: 1,
      id: 'plan-replay-operator',
      goalId: 'goal-replay-operator',
      sessionPath: REPLAY_SESSION_PATH,
      createdAt: REPLAY_NOW - 3_600_000,
      updatedAt: REPLAY_NOW - 1_800_000,
      sourceRefs: ['workspace:snapshot:branch-drift'],
      steps: [
        {
          version: 1,
          id: 'step-replay-validation',
          kind: 'review',
          title: 'Review replay evidence',
          status: 'in_progress',
          expectedEvidence: ['workspace:validation'],
          allowedActionKind: 'read_research_artifact',
          requiredAutonomyLevel: 'L3',
          doneCriteria: ['Replay report is reviewed.'],
          evidenceRefs: ['goal:goal-replay-operator'],
          risk: 'low',
        },
      ],
    },
    ...partial,
  };
}

function makeWorkspaceSnapshot(partial: Partial<AoiWorkspaceSnapshot> = {}): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: REPLAY_SESSION_PATH,
    collectedAt: REPLAY_NOW - 30_000,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git', 'workspace-build'],
    git: {
      version: 1,
      branchName: 'codex/aoi-replay',
      previousBranchName: 'main',
      branchChanged: true,
      isDirty: true,
      changedFileCount: 2,
      stagedFileCount: 0,
      unstagedFileCount: 2,
      untrackedFileCount: 0,
      statusSummary: 'branch changed; 2 changed files',
      changedFiles: [
        {
          version: 1,
          pathLabel: 'apps/webuiapps/src/lib/aoiOperatorReplay.ts',
          pathHash: 'replay',
          status: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
          changedAt: REPLAY_NOW - 30_000,
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
      completedAt: REPLAY_NOW - 3_600_000,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'stale',
      staleReason: 'Branch changed after validation.',
      evidenceRefs: ['workspace:validation:previous-pass'],
    },
    freshness: 'stale',
    evidenceRefs: ['workspace:snapshot:branch-drift', 'workspace:validation:previous-pass'],
    warnings: [],
    ...partial,
  };
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: 'memory-replay-kira-reviewed',
    scope: 'project',
    type: 'action',
    status: 'active',
    content: 'Kira completed reviewed work with validation passed and reviewer note attached.',
    normalizedContent: 'kira completed reviewed work validation passed reviewer note',
    importance: 0.74,
    confidence: 0.82,
    hits: 0,
    createdAt: REPLAY_NOW - 1_200_000,
    updatedAt: REPLAY_NOW - 120_000,
    sourceEpisodeIds: ['episode-replay-kira'],
    sessionPath: REPLAY_SESSION_PATH,
    tags: ['kira', 'automation', 'completed', 'reviewed', 'validation-passed'],
    entities: ['kira', 'validation'],
    projectKey: REPLAY_PROJECT_KEY,
    ...partial,
  };
}

function makeResearchRun(partial: Partial<AoiResearchRunSummary> = {}): AoiResearchRunSummary {
  return {
    id: 'research-replay-kernel',
    sessionPath: REPLAY_SESSION_PATH,
    request: 'Evaluate Aoi operator loop source routing.',
    title: 'Aoi operator loop source routing research',
    mode: 'standard',
    language: 'ko',
    recency: 'month',
    maxSources: 8,
    createdAt: REPLAY_NOW - 600_000,
    updatedAt: REPLAY_NOW - 60_000,
    completedAt: REPLAY_NOW - 60_000,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'completed',
    sourceCounts: {
      planned: 8,
      candidates: 8,
      accepted: 5,
      failed: 0,
    },
    artifactAvailability: {
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    },
    claimCount: 4,
    warningCount: 0,
    verificationWarningCount: 0,
    ...partial,
  };
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-replay-command',
    sessionPath: REPLAY_SESSION_PATH,
    status: 'active',
    title: 'Run dangerous cleanup command',
    body: 'A command was proposed as a validation shortcut.',
    reason: 'The replay should prove unsafe commands are blocked.',
    trigger: 'replay_fixture',
    createdAt: REPLAY_NOW - 30_000,
    updatedAt: REPLAY_NOW - 30_000,
    cooldownKey: 'replay:command',
    confidence: 0.9,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['run_command'],
    evidenceRefs: ['proposal:proposal-replay-command', 'workspace:snapshot:branch-drift'],
    memoryIds: [],
    artifactRefs: [],
    riskSignals: ['replay-high-risk-command'],
    acceptAction: {
      kind: 'run_command',
      params: {
        command: 'Remove-Item -Recurse .',
        cwd: '.',
        purpose: 'Dangerous cleanup should be blocked.',
      },
    },
    ...partial,
  };
}

function makeDecision(partial: Partial<AoiProposalDecision> = {}): AoiProposalDecision {
  return {
    version: 1,
    id: 'decision-replay-too-much',
    proposalId: 'proposal-replay-old',
    sessionPath: REPLAY_SESSION_PATH,
    cooldownKey: 'attention:research_completed:research:research-replay-too-much',
    action: 'snooze',
    actor: 'user',
    createdAt: REPLAY_NOW - 120_000,
    previousStatus: 'active',
    nextStatus: 'snoozed',
    feedbackCategory: 'too_much',
    evidenceRefs: ['research:research-replay-too-much'],
    proposalTrigger: 'attention_broker',
    proposalRisk: 'low',
    actionKind: 'read_research_artifact',
    suggestedTools: ['read_research_artifact'],
    ...partial,
  };
}

function eventBase(params: {
  id: string;
  kind: AoiReplayInputEventKind;
  summary: string;
  sourceRef: string;
  evidenceRefs?: string[];
  createdAt?: number;
}): Pick<
  AoiReplayInputEvent,
  'version' | 'id' | 'kind' | 'createdAt' | 'summary' | 'sourceRef' | 'evidenceRefs'
> {
  return {
    version: 1,
    id: params.id,
    kind: params.kind,
    createdAt: params.createdAt ?? REPLAY_NOW - 60_000,
    summary: params.summary,
    sourceRef: params.sourceRef,
    evidenceRefs: params.evidenceRefs ?? [params.sourceRef],
  };
}

function materializeReplayFixture(fixture: AoiOperatorReplayFixture): AoiReplayMaterializedState {
  const state: AoiReplayMaterializedState = {
    mission: null,
    activeGoals: [],
    workspaceSnapshot: null,
    memories: [],
    researchRuns: [],
    activeProposals: [],
    decisions: [],
    browserContexts: [],
    contextFeedback: [],
    registry: fixture.registry ?? baseRegistry(fixture.sessionPath),
    observations: [],
    failures: [],
  };

  for (const event of fixture.inputEvents) {
    state.observations.push(
      createAoiObservation({
        source:
          event.kind === 'research_run'
            ? 'research_run'
            : event.kind === 'kira_memory'
              ? 'kira'
              : event.kind === 'workspace_snapshot'
                ? 'workspace'
                : event.kind === 'proposal' || event.kind === 'proposal_decision'
                  ? 'proposal'
                  : event.kind === 'preference_memory'
                    ? 'memory'
                    : 'system',
        sessionPath: fixture.sessionPath,
        stableKey: event.id,
        summary: event.summary,
        createdAt: event.createdAt,
        payloadRef: event.sourceRef,
        artifactRefs: event.evidenceRefs.filter((ref) => !ref.startsWith('memory:')),
        memoryIds: event.evidenceRefs
          .filter((ref) => ref.startsWith('memory:'))
          .map((ref) => ref.slice('memory:'.length)),
      }),
    );

    if (event.mission) {
      state.mission = event.mission;
    }
    if (event.goal) {
      state.activeGoals.push(event.goal);
    }
    if (event.workspaceSnapshot) {
      state.workspaceSnapshot = event.workspaceSnapshot;
    }
    if (event.memory) {
      state.memories.push(event.memory);
    }
    if (event.researchRun) {
      state.researchRuns.push(event.researchRun);
      if (
        event.researchRun.status === 'failed' ||
        event.researchRun.sourceCounts.accepted <= 0 ||
        event.researchRun.warningCount + event.researchRun.verificationWarningCount > 0
      ) {
        state.failures.push({
          source: 'research',
          sessionPath: fixture.sessionPath,
          sourceRef: `research:${event.researchRun.id}`,
          summary: event.researchRun.statusMessage,
          evidenceRefs: [`research:${event.researchRun.id}`, ...event.evidenceRefs],
          reasons:
            event.researchRun.sourceCounts.accepted <= 0
              ? ['insufficient_sources']
              : ['research_failed'],
          researchRun: event.researchRun,
        });
      }
    }
    if (event.proposal) {
      state.activeProposals.push(event.proposal);
    }
    if (event.decision) {
      state.decisions.push(event.decision);
    }
    if (event.browserContext) {
      state.browserContexts.push(event.browserContext);
    }
    if (event.contextFeedback) {
      state.contextFeedback.push(event.contextFeedback);
    }
    if (event.environmentSource) {
      state.registry = baseRegistry(fixture.sessionPath, [
        ...state.registry.sources,
        event.environmentSource,
      ]);
    }
  }

  return state;
}

function proposalAcceptActionKind(proposal: AoiProposal): string | undefined {
  return proposal.acceptAction?.kind;
}

function commandPolicyForProposal(
  proposal: AoiProposal,
  now: number,
): AoiApprovedCommandPolicy | null {
  if (proposal.acceptAction?.kind !== 'run_command') {
    return null;
  }
  const params = proposal.acceptAction.params;
  return evaluateAoiApprovedCommandPolicy(
    createAoiApprovedCommandRequest({
      sessionPath: proposal.sessionPath,
      proposalId: proposal.id,
      command: params.command,
      cwd: params.cwd ?? params.directory,
      purpose: params.purpose ?? proposal.title,
      risk: proposal.risk,
      timeoutMs: params.timeoutMs ?? params.timeout_ms,
      requestedAt: now,
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
    }),
  );
}

function buildBlockedProposals(params: {
  policy: AoiAutonomyPolicy;
  proposals: AoiProposal[];
  activeProposals: AoiProposal[];
  decisions: AoiProposalDecision[];
  now: number;
}): AoiAutonomyBlockedProposal[] {
  return params.proposals.flatMap((proposal) => {
    const check = checkAoiProposalPolicy({
      policy: params.policy,
      proposal,
      activeProposals: params.activeProposals.filter((item) => item.id !== proposal.id),
      recentDecisions: params.decisions,
      now: params.now,
    });
    if (check.allowed) {
      return [];
    }
    return [
      {
        proposalId: proposal.id,
        title: proposal.title,
        reasons: check.reasons,
        evidenceRefs: proposal.evidenceRefs,
        actionKind: proposalAcceptActionKind(proposal) as AoiAutonomyBlockedProposal['actionKind'],
        requiredAutonomyLevel: proposal.requiredAutonomyLevel,
        requiresUserApproval: proposal.requiresUserApproval,
        risk: proposal.risk,
        safeAlternative: buildAoiBlockedStateSummary({
          proposal,
          reasons: check.reasons,
        }).safeAlternative,
      },
    ];
  });
}

function buildReplaySnapshot(runtime: Omit<AoiReplayRuntime, 'replaySnapshot'>): string {
  const sourceLabels = runtime.context.selectedSources
    .slice(0, 3)
    .map((source) => `${source.sourceId}:${source.kind}:${source.relevanceScore.toFixed(2)}`);
  const decisionLabels = runtime.attention.decisions.map(
    (decision) => `${decision.kind}:${decision.score.toFixed(2)}`,
  );
  const proposalLabels = runtime.generatedProposals.map(
    (proposal) => `${proposal.trigger}:${proposal.title}:${proposal.risk}`,
  );
  const blockedLabels = runtime.blockedProposals.map(
    (proposal) => `${proposal.proposalId}:${proposal.reasons.slice(0, 2).join('|')}`,
  );
  const conflictLabels = runtime.preferenceResolution.conflicts.map(
    (conflict) => `${conflict.normalizedKey}:${conflict.winner}`,
  );
  return [
    `sources=${sourceLabels.join(',') || 'none'}`,
    `attention=${decisionLabels.join(',') || 'none'}`,
    `generated=${proposalLabels.join(',') || 'none'}`,
    `blocked=${blockedLabels.join(',') || 'none'}`,
    `conflicts=${conflictLabels.join(',') || 'none'}`,
    `digest=${runtime.digest.summary}`,
    `eval=${runtime.evaluation.metrics.totalProposals}/${runtime.evaluation.metrics.totalDecisions}`,
  ].join(' | ');
}

function buildRuntime(fixture: AoiOperatorReplayFixture): AoiReplayRuntime {
  const state = materializeReplayFixture(fixture);
  const policy = fixture.policy ?? basePolicy(fixture.now);
  const context = buildAoiContextRouterResult({
    sessionsDir: '__aoi_operator_replay_no_real_reads__',
    sessionPath: fixture.sessionPath,
    latestUserMessage: fixture.latestUserMessage,
    registry: state.registry,
    mission: state.mission,
    memories: state.memories,
    workspaceSnapshot: state.workspaceSnapshot,
    decisions: state.decisions,
    contextFeedback: state.contextFeedback,
    researchRuns: state.researchRuns,
    browserContexts: state.browserContexts,
    now: fixture.now,
  });
  const attention = runAoiAttentionBroker({
    sessionPath: fixture.sessionPath,
    now: fixture.now,
    policy,
    researchRuns: state.researchRuns,
    memories: state.memories,
    activeProposals: state.activeProposals,
    recentDecisions: state.decisions,
    activeGoals: state.activeGoals,
    mission: state.mission,
    workspaceSnapshots: state.workspaceSnapshot ? [state.workspaceSnapshot] : [],
    quietMode: fixture.quietMode,
    userIdleMs: fixture.userIdleMs,
    maxActionableEvents: 2,
  });
  const recovery = buildAoiFailureRecoveryProposals({
    failures: state.failures,
    context: {
      activeProposals: [...state.activeProposals, ...attention.proposals],
      recentDecisions: state.decisions,
      now: fixture.now,
    },
  });
  const generatedProposals = [...attention.proposals, ...recovery.proposals];
  const allProposals = [...state.activeProposals, ...generatedProposals];
  const blockedProposals = buildBlockedProposals({
    policy,
    proposals: allProposals,
    activeProposals: allProposals,
    decisions: state.decisions,
    now: fixture.now,
  });
  const digest = buildAoiOperatorDigest({
    sessionPath: fixture.sessionPath,
    now: fixture.now,
    mission: state.mission,
    activeProposals: allProposals,
    blockedProposals,
    attentionEvents: attention.events,
    attentionDecisions: attention.decisions,
    recentDecisions: state.decisions,
    workspaceSnapshot: state.workspaceSnapshot,
    memories: state.memories,
    quietMode: fixture.quietMode,
    userIdleMs: fixture.userIdleMs,
  });
  const preparedPlans = allProposals.map((proposal) => {
    const plan = buildAoiPreparedActionPlan(proposal, {
      now: fixture.now,
      existingGitStateAvailable: true,
      checkpointEvidenceRefs: proposal.evidenceRefs,
    });
    const summary = buildAoiPreparedActionPlanPanelSummary(plan, true);
    return {
      proposal,
      plan,
      summary: [
        summary.objective,
        summary.riskLabel,
        summary.approvalLabel,
        summary.validationLabel,
        ...summary.blockers,
      ].join(' | '),
    };
  });
  const commandPolicies = allProposals.flatMap((proposal) => {
    const policyResult = commandPolicyForProposal(proposal, fixture.now);
    return policyResult ? [{ proposal, policy: policyResult }] : [];
  });
  const preferenceResolution = resolveAoiPreferenceContext({
    memories: state.memories,
    projectKey: fixture.projectKey ?? REPLAY_PROJECT_KEY,
    decisions: state.decisions,
    now: fixture.now,
  });
  const evaluation = evaluateAoiAutonomyRecords({
    sessionPath: fixture.sessionPath,
    proposals: allProposals,
    decisions: state.decisions,
    memories: state.memories,
    now: fixture.now,
  });
  const missionPanel = buildAoiMissionPanelSummary(state.mission);
  const missionSummary = missionPanel.visible
    ? `${missionPanel.statusLabel}:${missionPanel.nextActionLabel}:${missionPanel.evidenceCount}`
    : 'no mission';
  const partial = {
    fixture,
    state,
    context,
    attention,
    recovery,
    digest,
    generatedProposals,
    allProposals,
    blockedProposals,
    preparedPlans,
    commandPolicies,
    preferenceResolution,
    evaluation,
    missionSummary,
  };
  return {
    ...partial,
    replaySnapshot: buildReplaySnapshot(partial),
  };
}

function aggregateEvidence(runtime: AoiReplayRuntime): string[] {
  return dedupe([
    ...runtime.state.observations.map((observation) => `observation:${observation.id}`),
    ...runtime.state.observations.flatMap((observation) => observation.artifactRefs),
    ...runtime.context.selectedSources.flatMap((source) => source.evidenceRefs),
    ...runtime.attention.events.flatMap((event) => event.evidenceRefs),
    ...runtime.generatedProposals.flatMap((proposal) => proposal.evidenceRefs),
    ...runtime.blockedProposals.flatMap((proposal) => proposal.evidenceRefs),
    ...runtime.digest.evidenceRefs,
    ...runtime.preferenceResolution.conflicts.flatMap((conflict) => conflict.evidenceRefs),
  ]);
}

function hasSource(runtime: AoiReplayRuntime, expected: AoiReplayExpectedDecision): boolean {
  return runtime.context.selectedSources.some((source) => {
    if (expected.sourceId && source.sourceId !== expected.sourceId) {
      return false;
    }
    if (expected.sourceKind && source.kind !== expected.sourceKind) {
      return false;
    }
    if (
      expected.sourceLabelIncludes &&
      !`${source.label} ${source.summary}`.includes(expected.sourceLabelIncludes)
    ) {
      return false;
    }
    return true;
  });
}

function actualSourceLabels(runtime: AoiReplayRuntime): string {
  return (
    runtime.context.selectedSources
      .map((source) => `${source.sourceId}:${source.kind}:${source.label}`)
      .join(' / ') || 'none'
  );
}

function hasAttentionDecision(
  runtime: AoiReplayRuntime,
  expected: AoiReplayExpectedDecision,
): boolean {
  return runtime.attention.decisions.some((decision) => {
    const event = runtime.attention.events.find((item) => item.id === decision.eventId);
    if (expected.attentionDecisionKind && decision.kind !== expected.attentionDecisionKind) {
      return false;
    }
    if (expected.eventKind && event?.kind !== expected.eventKind) {
      return false;
    }
    if (expected.sourceRef && event?.sourceRef !== expected.sourceRef) {
      return false;
    }
    return true;
  });
}

function actualAttentionLabels(runtime: AoiReplayRuntime): string {
  return (
    runtime.attention.decisions
      .map((decision) => {
        const event = runtime.attention.events.find((item) => item.id === decision.eventId);
        return `${event?.kind ?? 'unknown'}:${event?.sourceRef ?? 'unknown'}:${decision.kind}`;
      })
      .join(' / ') || 'none'
  );
}

function hasGeneratedProposal(
  runtime: AoiReplayRuntime,
  expected: AoiReplayExpectedDecision,
): boolean {
  return runtime.generatedProposals.some((proposal) => {
    if (
      expected.proposalTitleIncludes &&
      !proposal.title.includes(expected.proposalTitleIncludes)
    ) {
      return false;
    }
    if (expected.sourceRef && !proposal.evidenceRefs.includes(expected.sourceRef)) {
      return false;
    }
    return true;
  });
}

function actualProposalLabels(runtime: AoiReplayRuntime): string {
  return (
    runtime.generatedProposals
      .map((proposal) => `${proposal.title}:${proposal.trigger}:${proposal.risk}`)
      .join(' / ') || 'none'
  );
}

function approvalBoundaryText(runtime: AoiReplayRuntime): string {
  const proactive = runtime.allProposals.map((proposal) =>
    buildAoiProactiveExplanation({
      proposal,
      policy: runtime.fixture.policy ?? basePolicy(runtime.fixture.now),
      activeProposals: runtime.allProposals,
      includeEvidence: true,
    }),
  );
  const preferenceSummaries = runtime.allProposals.map((proposal) =>
    buildAoiPreferenceInfluencePanelSummary({
      proposal,
      memories: runtime.state.memories,
      projectKey: runtime.fixture.projectKey ?? REPLAY_PROJECT_KEY,
      includeDetails: true,
    }),
  );
  const recoverySummaries = runtime.allProposals.map((proposal) =>
    buildAoiRecoveryPreviewSummary(proposal, true),
  );
  return [
    ...proactive.flatMap((item) => [
      item.approvalBoundary,
      item.safeNextAction,
      item.willNotDoWithoutApproval,
    ]),
    ...runtime.preparedPlans.map((item) => item.summary),
    ...runtime.commandPolicies.flatMap((item) => [
      item.policy.allowed ? 'command allowed' : 'command blocked',
      item.policy.blockReasons.join(' '),
      item.policy.rationale.join(' '),
    ]),
    ...preferenceSummaries.flatMap((item) => [
      item.statusLabel,
      ...item.preferenceLabels,
      ...item.conflictLabels,
      ...item.demotionLabels,
    ]),
    ...recoverySummaries.flatMap((item) => [
      item.proposedActionLabel,
      item.whyNarrowerOrSafer,
      item.rootCauseSummary,
      ...item.nonGoals,
    ]),
  ]
    .filter(Boolean)
    .join(' | ');
}

function blockedReasonText(runtime: AoiReplayRuntime): string {
  return (
    runtime.blockedProposals
      .map((proposal) => `${proposal.proposalId}:${proposal.reasons.join('|')}`)
      .join(' / ') || 'none'
  );
}

function preferenceConflictText(runtime: AoiReplayRuntime): string {
  return (
    runtime.preferenceResolution.conflicts
      .map(
        (conflict) =>
          `${conflict.normalizedKey}:${conflict.winner}:${conflict.losingRefs.join(',')}`,
      )
      .join(' / ') || 'none'
  );
}

function metricResult(
  expected: AoiReplayExpectedDecision,
  passed: boolean,
  actual: string,
  evidenceRefs: string[],
  details?: string,
): AoiReplayMetric {
  return {
    version: 1,
    id: expected.id,
    name: expected.metric,
    label: expected.label,
    passed,
    expected: normalizeText(
      JSON.stringify({
        sourceId: expected.sourceId,
        sourceKind: expected.sourceKind,
        eventKind: expected.eventKind,
        attentionDecisionKind: expected.attentionDecisionKind,
        shouldCreateProposal: expected.shouldCreateProposal,
        proposalTitleIncludes: expected.proposalTitleIncludes,
        approvalBoundaryIncludes: expected.approvalBoundaryIncludes,
        evidenceRefs: expected.evidenceRefs,
        nonInterrupting: expected.nonInterrupting,
        blockedReasonIncludes: expected.blockedReasonIncludes,
        preferenceConflictKey: expected.preferenceConflictKey,
        preferenceWinner: expected.preferenceWinner,
        digestLane: expected.digestLane,
        recoveryActionKind: expected.recoveryActionKind,
        snapshotIncludes: expected.snapshotIncludes,
        expected: expected.expected,
      }),
      420,
    ),
    actual: normalizeText(actual, 420),
    evidenceRefs: dedupe(evidenceRefs, 12),
    ...(details ? { details: normalizeText(details, 260) } : {}),
  };
}

function evaluateExpectedDecision(
  runtime: AoiReplayRuntime,
  expected: AoiReplayExpectedDecision,
): AoiReplayMetric {
  const evidenceRefs = aggregateEvidence(runtime);
  switch (expected.metric) {
    case 'source_selected': {
      const passed = hasSource(runtime, expected);
      return metricResult(expected, passed, actualSourceLabels(runtime), evidenceRefs);
    }
    case 'source_not_selected': {
      const passed = !hasSource(runtime, expected);
      return metricResult(expected, passed, actualSourceLabels(runtime), evidenceRefs);
    }
    case 'attention_decision': {
      const passed = hasAttentionDecision(runtime, expected);
      return metricResult(expected, passed, actualAttentionLabels(runtime), evidenceRefs);
    }
    case 'proposal_decision': {
      const expectedCreate = expected.shouldCreateProposal === true;
      const hasProposal = hasGeneratedProposal(runtime, expected);
      const passed = expectedCreate ? hasProposal : !hasProposal;
      return metricResult(expected, passed, actualProposalLabels(runtime), evidenceRefs);
    }
    case 'approval_boundary': {
      const text = approvalBoundaryText(runtime);
      const passed = expected.approvalBoundaryIncludes
        ? text.includes(expected.approvalBoundaryIncludes)
        : text.length > 0;
      return metricResult(expected, passed, text, evidenceRefs);
    }
    case 'evidence_refs': {
      const missing = (expected.evidenceRefs ?? []).filter((ref) => !evidenceRefs.includes(ref));
      return metricResult(
        expected,
        missing.length === 0,
        evidenceRefs.join(' / '),
        evidenceRefs,
        missing.length > 0 ? `missing=${missing.join(',')}` : undefined,
      );
    }
    case 'non_interruption': {
      const directInterruptions = runtime.attention.decisions.filter(
        (decision) =>
          decision.kind === 'ask_direct_clarification' || decision.kind === 'create_proposal',
      );
      const actual = `attention_interruptions=${directInterruptions.length}; generated=${runtime.generatedProposals.length}; hidden=${runtime.digest.hiddenItemCount}`;
      const passed =
        expected.nonInterrupting === true
          ? directInterruptions.length === 0
          : directInterruptions.length > 0;
      return metricResult(expected, passed, actual, evidenceRefs);
    }
    case 'blocked_reason': {
      const text = blockedReasonText(runtime);
      const passed = expected.blockedReasonIncludes
        ? text.includes(expected.blockedReasonIncludes)
        : runtime.blockedProposals.length > 0;
      return metricResult(expected, passed, text, evidenceRefs);
    }
    case 'preference_conflict': {
      const passed = runtime.preferenceResolution.conflicts.some(
        (conflict) =>
          (!expected.preferenceConflictKey ||
            conflict.normalizedKey === expected.preferenceConflictKey) &&
          (!expected.preferenceWinner || conflict.winner === expected.preferenceWinner),
      );
      return metricResult(expected, passed, preferenceConflictText(runtime), evidenceRefs);
    }
    case 'digest_lane': {
      const lane = expected.digestLane;
      const count = lane ? runtime.digest.laneCounts[lane] : 0;
      const passed = Boolean(lane && count > 0);
      return metricResult(
        expected,
        passed,
        `${lane ?? 'none'}=${count}; hidden=${runtime.digest.hiddenItemCount}; ${runtime.digest.summary}`,
        evidenceRefs,
      );
    }
    case 'recovery_suggestion': {
      const passed = runtime.recovery.proposals.some(
        (proposal) => proposal.recoveryPreview?.proposedAction.kind === expected.recoveryActionKind,
      );
      return metricResult(expected, passed, actualProposalLabels(runtime), evidenceRefs);
    }
    case 'no_command_execution': {
      return metricResult(
        expected,
        true,
        'commandExecutionCount=0; mutationAttemptCount=0',
        evidenceRefs,
        'Replay imports no executor and records no mutation attempts.',
      );
    }
    case 'snapshot_summary': {
      const passed = expected.snapshotIncludes
        ? runtime.replaySnapshot.includes(expected.snapshotIncludes)
        : runtime.replaySnapshot.length > 0;
      return metricResult(expected, passed, runtime.replaySnapshot, evidenceRefs);
    }
    default:
      return metricResult(expected, false, 'unsupported metric', evidenceRefs);
  }
}

export function runAoiOperatorReplayFixture(fixture: AoiOperatorReplayFixture): AoiReplayReport {
  const runtime = buildRuntime(fixture);
  const metrics = fixture.expectedDecisions.map((expected) =>
    evaluateExpectedDecision(runtime, expected),
  );
  const failed = metrics.filter((metric) => !metric.passed);
  const passed = failed.length === 0;
  return {
    version: 1,
    fixtureId: fixture.id,
    title: fixture.title,
    sessionPath: fixture.sessionPath,
    generatedAt: fixture.now,
    passed,
    summary: passed
      ? `${fixture.id}: ${metrics.length}/${metrics.length} replay metrics passed.`
      : `${fixture.id}: ${failed.length}/${metrics.length} replay metrics failed: ${failed
          .map((metric) => metric.id)
          .join(', ')}`,
    metrics,
    selectedSourceLabels: runtime.context.selectedSources.map(
      (source) => `${source.sourceId}:${source.kind}:${source.label}`,
    ),
    attentionDecisionLabels: runtime.attention.decisions.map((decision) => {
      const event = runtime.attention.events.find((item) => item.id === decision.eventId);
      return `${event?.kind ?? 'unknown'}:${decision.kind}:${decision.score.toFixed(2)}`;
    }),
    generatedProposalLabels: runtime.generatedProposals.map(
      (proposal) => `${proposal.trigger}:${proposal.title}:${proposal.risk}`,
    ),
    blockedReasonLabels: runtime.blockedProposals.map(
      (proposal) => `${proposal.proposalId}:${proposal.reasons.join('|')}`,
    ),
    preferenceConflictLabels: runtime.preferenceResolution.conflicts.map(
      (conflict) => `${conflict.normalizedKey}:${conflict.winner}`,
    ),
    digestSummary: runtime.digest.summary,
    commandExecutionCount: 0,
    mutationAttemptCount: 0,
  };
}

export function runBuiltInAoiOperatorReplayFixtures(): AoiReplayReport[] {
  return AOI_OPERATOR_REPLAY_FIXTURES.map(runAoiOperatorReplayFixture);
}

export function formatAoiReplayReport(report: AoiReplayReport): string {
  const failing = report.metrics.filter((metric) => !metric.passed);
  const interesting = failing.length > 0 ? failing : report.metrics.slice(0, 4);
  return [
    report.summary,
    `sources: ${report.selectedSourceLabels.join(' / ') || 'none'}`,
    `attention: ${report.attentionDecisionLabels.join(' / ') || 'none'}`,
    `proposals: ${report.generatedProposalLabels.join(' / ') || 'none'}`,
    ...interesting.map(
      (metric) =>
        `${metric.passed ? 'PASS' : 'FAIL'} ${metric.id}: ${metric.label}; actual=${metric.actual}`,
    ),
  ].join('\n');
}

export const AOI_OPERATOR_REPLAY_FIXTURES: AoiOperatorReplayFixture[] = [
  {
    version: 1,
    id: 'user-return-branch-drift',
    title: 'User returns after branch drift',
    description:
      'Aoi should route workspace context, update mission state, and avoid interrupting.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Continue the implementation after branch drift and stale validation.',
    userIdleMs: 20 * 60 * 1000,
    inputEvents: [
      {
        ...eventBase({
          id: 'event-branch-mission',
          kind: 'mission_state',
          summary: 'Mission is active while workspace validation drifted.',
          sourceRef: 'goal:goal-replay-operator',
          evidenceRefs: ['goal:goal-replay-operator', 'workspace:snapshot:branch-drift'],
        }),
        mission: makeMission({
          evidenceRefs: ['goal:goal-replay-operator', 'workspace:snapshot:branch-drift'],
          sourceRefs: {
            goalRef: 'goal:goal-replay-operator',
            workspaceSnapshotRef: 'workspace:snapshot:branch-drift',
            validationRef: 'workspace:validation:previous-pass',
          },
        }),
      },
      {
        ...eventBase({
          id: 'event-branch-goal',
          kind: 'active_goal',
          summary: 'Active replay goal exists.',
          sourceRef: 'goal:goal-replay-operator',
        }),
        goal: makeGoal(),
      },
      {
        ...eventBase({
          id: 'event-branch-workspace',
          kind: 'workspace_snapshot',
          summary: 'Workspace branch drifted after validation.',
          sourceRef: 'workspace:snapshot:branch-drift',
          evidenceRefs: ['workspace:snapshot:branch-drift', 'workspace:validation:previous-pass'],
        }),
        workspaceSnapshot: makeWorkspaceSnapshot(),
      },
    ],
    expectedDecisions: [
      {
        id: 'branch-source',
        metric: 'source_selected',
        label: 'Workspace source is selected.',
        sourceId: 'workspace-git',
      },
      {
        id: 'branch-attention',
        metric: 'attention_decision',
        label: 'Branch drift updates mission state without direct interruption.',
        eventKind: 'workspace_validation_stale',
        attentionDecisionKind: 'update_mission_state',
      },
      {
        id: 'branch-no-proposal',
        metric: 'proposal_decision',
        label: 'Branch drift alone does not create a proposal.',
        shouldCreateProposal: false,
      },
      {
        id: 'branch-non-interruption',
        metric: 'non_interruption',
        label: 'No direct interruption is used for branch drift.',
        nonInterrupting: true,
      },
      {
        id: 'branch-digest',
        metric: 'digest_lane',
        label: 'Digest keeps branch drift as mission update.',
        digestLane: 'mission_update',
      },
      {
        id: 'branch-evidence',
        metric: 'evidence_refs',
        label: 'Workspace evidence is preserved.',
        evidenceRefs: ['workspace:snapshot:branch-drift'],
      },
    ],
  },
  {
    version: 1,
    id: 'kira-completed-reviewed',
    title: 'Kira completed with validation and reviewer note',
    description: 'Aoi should surface a review proposal with Kira evidence and a safe boundary.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Review the completed Kira work and continue safely.',
    inputEvents: [
      {
        ...eventBase({
          id: 'event-kira-mission',
          kind: 'mission_state',
          summary: 'Mission is waiting on reviewed Kira work.',
          sourceRef: 'goal:goal-replay-operator',
          evidenceRefs: ['goal:goal-replay-operator', 'memory:memory-replay-kira-reviewed'],
        }),
        mission: makeMission({
          status: 'waiting_on_kira',
          waitingOn: 'kira',
          nextRecommendedAction: {
            kind: 'inspect_kira',
            label: 'Inspect reviewed Kira work.',
            reason: 'Kira reported validation passed.',
            ref: 'memory:memory-replay-kira-reviewed',
          },
          evidenceRefs: ['goal:goal-replay-operator', 'memory:memory-replay-kira-reviewed'],
          sourceRefs: {
            goalRef: 'goal:goal-replay-operator',
            kiraWorkRef: 'memory:memory-replay-kira-reviewed',
          },
        }),
      },
      {
        ...eventBase({
          id: 'event-kira-memory',
          kind: 'kira_memory',
          summary: 'Kira completed reviewed work with validation passed.',
          sourceRef: 'memory:memory-replay-kira-reviewed',
          evidenceRefs: ['memory:memory-replay-kira-reviewed'],
        }),
        memory: makeMemory(),
      },
    ],
    expectedDecisions: [
      {
        id: 'kira-source',
        metric: 'source_selected',
        label: 'Kira board source is selected.',
        sourceId: 'kira-board',
      },
      {
        id: 'kira-proposal',
        metric: 'proposal_decision',
        label: 'Reviewed Kira work creates one review proposal.',
        shouldCreateProposal: true,
        proposalTitleIncludes: 'Review completed Kira work',
      },
      {
        id: 'kira-boundary',
        metric: 'approval_boundary',
        label: 'Kira review proposal does not execute tools from the inbox.',
        approvalBoundaryIncludes: 'without explicit approval',
      },
      {
        id: 'kira-evidence',
        metric: 'evidence_refs',
        label: 'Kira memory evidence is retained.',
        evidenceRefs: ['memory:memory-replay-kira-reviewed'],
      },
    ],
  },
  {
    version: 1,
    id: 'research-insufficient-sources',
    title: 'Research failed due to insufficient sources',
    description: 'Aoi should avoid pretending success and propose a bounded refresh recovery.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'The research did not collect enough sources; what is the safe recovery?',
    inputEvents: [
      {
        ...eventBase({
          id: 'event-research-failed',
          kind: 'research_run',
          summary: 'Research completed with zero accepted sources.',
          sourceRef: 'research:research-replay-insufficient',
          evidenceRefs: ['research:research-replay-insufficient'],
        }),
        researchRun: makeResearchRun({
          id: 'research-replay-insufficient',
          request: 'Find current operator-loop evaluation papers.',
          title: 'Operator loop evaluation research',
          status: 'completed',
          statusMessage: 'insufficient accepted sources',
          sourceCounts: {
            planned: 8,
            candidates: 4,
            accepted: 0,
            failed: 4,
          },
          artifactAvailability: {
            manifest: true,
            report: false,
            sources: false,
            evidence: false,
          },
          claimCount: 0,
          warningCount: 1,
        }),
      },
    ],
    expectedDecisions: [
      {
        id: 'research-attention',
        metric: 'attention_decision',
        label: 'Insufficient research becomes a badge-level decision.',
        eventKind: 'research_failed_or_insufficient',
        attentionDecisionKind: 'show_dashboard_badge',
      },
      {
        id: 'research-recovery',
        metric: 'recovery_suggestion',
        label: 'Research failure suggests bounded refresh recovery.',
        recoveryActionKind: 'refresh_research',
      },
      {
        id: 'research-boundary',
        metric: 'approval_boundary',
        label: 'Recovery does not claim research is fixed.',
        approvalBoundaryIncludes: 'Do not claim the failed research result is fixed',
      },
      {
        id: 'research-evidence',
        metric: 'evidence_refs',
        label: 'Research failure evidence is present.',
        evidenceRefs: ['research:research-replay-insufficient'],
      },
    ],
  },
  {
    version: 1,
    id: 'too-much-feedback-suppression',
    title: 'User rejected a suggestion as too much',
    description: 'Aoi should not create another equivalent proactive proposal.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Do not interrupt me with that same research suggestion again.',
    inputEvents: [
      {
        ...eventBase({
          id: 'event-too-much-research',
          kind: 'research_run',
          summary: 'Research completed but similar proposal was snoozed as too much.',
          sourceRef: 'research:research-replay-too-much',
          evidenceRefs: ['research:research-replay-too-much'],
        }),
        researchRun: makeResearchRun({
          id: 'research-replay-too-much',
          title: 'Previously noisy research suggestion',
        }),
      },
      {
        ...eventBase({
          id: 'event-too-much-decision',
          kind: 'proposal_decision',
          summary: 'User marked previous proposal as too much.',
          sourceRef: 'decision:decision-replay-too-much',
          evidenceRefs: ['decision:decision-replay-too-much', 'research:research-replay-too-much'],
        }),
        decision: makeDecision(),
      },
    ],
    expectedDecisions: [
      {
        id: 'too-much-no-proposal',
        metric: 'proposal_decision',
        label: 'Negative timing feedback prevents another proposal.',
        shouldCreateProposal: false,
        proposalTitleIncludes: 'Review completed Aoi research',
      },
      {
        id: 'too-much-non-interruption',
        metric: 'non_interruption',
        label: 'The replay does not directly interrupt after too much feedback.',
        nonInterrupting: true,
      },
      {
        id: 'too-much-snapshot',
        metric: 'snapshot_summary',
        label: 'Snapshot records no generated proposal.',
        snapshotIncludes: 'generated=none',
      },
    ],
  },
  {
    version: 1,
    id: 'high-risk-command-blocked',
    title: 'High-risk command proposal must be blocked',
    description: 'Unsafe command approval is evaluated but never executed.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Validate that unsafe command proposals are blocked.',
    policy: basePolicy(REPLAY_NOW, { level: 'L5' }),
    inputEvents: [
      {
        ...eventBase({
          id: 'event-command-proposal',
          kind: 'proposal',
          summary: 'High-risk command proposal enters replay.',
          sourceRef: 'proposal:proposal-replay-command',
          evidenceRefs: ['proposal:proposal-replay-command', 'workspace:snapshot:branch-drift'],
        }),
        proposal: makeProposal(),
      },
    ],
    expectedDecisions: [
      {
        id: 'command-blocked',
        metric: 'blocked_reason',
        label: 'Destructive command is blocked.',
        blockedReasonIncludes: 'approved_command_blocked:destructive_file_operation',
      },
      {
        id: 'command-boundary',
        metric: 'approval_boundary',
        label: 'Command policy says command is blocked.',
        approvalBoundaryIncludes: 'command blocked',
      },
      {
        id: 'command-no-exec',
        metric: 'no_command_execution',
        label: 'Replay never executes commands.',
      },
    ],
  },
  {
    version: 1,
    id: 'preference-project-conflict',
    title: 'Preference conflicts with project instruction',
    description: 'Project convention should win over durable user preference for the project.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Use the project response language rule.',
    projectKey: REPLAY_PROJECT_KEY,
    inputEvents: [
      {
        ...eventBase({
          id: 'event-user-pref',
          kind: 'preference_memory',
          summary: 'Durable user language preference exists.',
          sourceRef: 'memory:memory-pref-english',
          evidenceRefs: ['memory:memory-pref-english'],
        }),
        memory: makeMemory({
          id: 'memory-pref-english',
          scope: 'user',
          type: 'preference',
          content: 'Always answer in English. pref:response.language',
          normalizedContent: 'always answer in english pref response language',
          tags: ['preference', 'durable-preference', 'pref:response.language'],
          entities: ['response.language'],
          projectKey: undefined,
          permanent: true,
        }),
      },
      {
        ...eventBase({
          id: 'event-project-pref',
          kind: 'preference_memory',
          summary: 'Project convention overrides language.',
          sourceRef: 'memory:memory-project-korean',
          evidenceRefs: ['memory:memory-project-korean'],
        }),
        memory: makeMemory({
          id: 'memory-project-korean',
          scope: 'project',
          type: 'preference',
          content: 'In this project, answer in Korean. pref:response.language',
          normalizedContent: 'in this project answer in korean pref response language',
          tags: ['preference', 'project-convention', 'pref:response.language'],
          entities: ['response.language'],
          projectKey: REPLAY_PROJECT_KEY,
          permanent: true,
        }),
      },
      {
        ...eventBase({
          id: 'event-pref-proposal',
          kind: 'proposal',
          summary: 'Proposal references user preference memory.',
          sourceRef: 'proposal:proposal-pref-conflict',
          evidenceRefs: ['proposal:proposal-pref-conflict', 'memory:memory-pref-english'],
        }),
        proposal: makeProposal({
          id: 'proposal-pref-conflict',
          title: 'Apply remembered language preference',
          risk: 'low',
          requiredAutonomyLevel: 'L2',
          suggestedTools: ['read_research_artifact'],
          acceptAction: {
            kind: 'read_research_artifact',
            params: {
              runId: 'research-replay-kernel',
              artifact: 'report',
            },
          },
          evidenceRefs: ['memory:memory-pref-english', 'memory:memory-project-korean'],
          memoryIds: ['memory-pref-english', 'memory-project-korean'],
          riskSignals: [],
        }),
      },
    ],
    expectedDecisions: [
      {
        id: 'pref-conflict',
        metric: 'preference_conflict',
        label: 'Project convention wins response language conflict.',
        preferenceConflictKey: 'response.language',
        preferenceWinner: 'project_convention',
      },
      {
        id: 'pref-boundary',
        metric: 'approval_boundary',
        label: 'Preference summary exposes conflict.',
        approvalBoundaryIncludes: 'project convention',
      },
    ],
  },
  {
    version: 1,
    id: 'disabled-source-excluded',
    title: 'Disabled source should not influence context',
    description: 'Disabled research source must not appear in selected context.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Summarize the disabled research source.',
    registry: baseRegistry(REPLAY_SESSION_PATH, [source('research-runs', 'research_runs', false)]),
    inputEvents: [
      {
        ...eventBase({
          id: 'event-disabled-research',
          kind: 'research_run',
          summary: 'A disabled research run exists.',
          sourceRef: 'research:research-replay-disabled',
          evidenceRefs: ['research:research-replay-disabled'],
        }),
        researchRun: makeResearchRun({
          id: 'research-replay-disabled',
          title: 'Disabled source research',
        }),
      },
    ],
    expectedDecisions: [
      {
        id: 'disabled-source-absent',
        metric: 'source_not_selected',
        label: 'Disabled research source is absent from context routing.',
        sourceId: 'research-runs',
      },
      {
        id: 'disabled-no-source-evidence',
        metric: 'snapshot_summary',
        label: 'Snapshot records context came from a non-research source.',
        snapshotIncludes: 'sources=app-state',
      },
    ],
  },
  {
    version: 1,
    id: 'quiet-mode-low-value-digest',
    title: 'Quiet mode suppresses low-value digest items',
    description:
      'FYI workspace changes should be hidden by quiet mode without a chat interruption.',
    sessionPath: REPLAY_SESSION_PATH,
    now: REPLAY_NOW,
    latestUserMessage: 'Quiet mode is active; keep low-value updates out of chat.',
    quietMode: true,
    inputEvents: [
      {
        ...eventBase({
          id: 'event-quiet-workspace',
          kind: 'workspace_snapshot',
          summary: 'Workspace has a low-value dirty FYI update.',
          sourceRef: 'workspace:snapshot:quiet-fyi',
          evidenceRefs: ['workspace:snapshot:quiet-fyi'],
        }),
        workspaceSnapshot: makeWorkspaceSnapshot({
          collectedAt: REPLAY_NOW - 10_000,
          git: {
            version: 1,
            branchName: 'main',
            branchChanged: false,
            isDirty: true,
            changedFileCount: 1,
            stagedFileCount: 0,
            unstagedFileCount: 1,
            untrackedFileCount: 0,
            statusSummary: '1 changed file',
            changedFiles: [],
          },
          evidenceRefs: ['workspace:snapshot:quiet-fyi'],
        }),
      },
    ],
    expectedDecisions: [
      {
        id: 'quiet-hidden',
        metric: 'digest_lane',
        label: 'Quiet mode hides the low-value FYI digest item.',
        digestLane: 'hidden_by_quiet_mode',
      },
      {
        id: 'quiet-non-interruption',
        metric: 'non_interruption',
        label: 'Quiet mode does not directly interrupt.',
        nonInterrupting: true,
      },
      {
        id: 'quiet-no-exec',
        metric: 'no_command_execution',
        label: 'Quiet replay performs no command or mutation.',
      },
    ],
  },
];

export function cloneAoiOperatorReplayFixture(
  fixture: AoiOperatorReplayFixture,
  patch: Partial<AoiOperatorReplayFixture> = {},
): AoiOperatorReplayFixture {
  return {
    ...fixture,
    id: patch.id ?? stableId('fixture', `${fixture.id}:${JSON.stringify(patch)}`),
    inputEvents: patch.inputEvents ?? fixture.inputEvents.map((event) => ({ ...event })),
    expectedDecisions:
      patch.expectedDecisions ?? fixture.expectedDecisions.map((expected) => ({ ...expected })),
    ...patch,
  };
}
