export type AoiAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AoiAutonomyRisk = 'low' | 'medium' | 'high';

export type AoiEnvironmentSourceKind =
  | 'workspace_git'
  | 'workspace_build'
  | 'kira_board'
  | 'research_runs'
  | 'app_state'
  | 'browser_context'
  | 'manual_note';

export type AoiEnvironmentSourceOperation = 'summarize' | 'status' | 'diff' | 'read_metadata';

export type AoiEnvironmentSourceScope = 'session' | 'project' | 'workspace' | 'explicit_target';

export type AoiEnvironmentSourceQuietModeBehavior = 'record_only' | 'suppress';

export interface AoiEnvironmentSource {
  version: 1;
  id: string;
  kind: AoiEnvironmentSourceKind;
  label: string;
  enabled: boolean;
  scope: AoiEnvironmentSourceScope;
  risk: AoiAutonomyRisk;
  allowedOperations: AoiEnvironmentSourceOperation[];
  privateByDefault: boolean;
  quietModeBehavior: AoiEnvironmentSourceQuietModeBehavior;
  updatedAt: number;
  lastObservedAt?: number;
  consentReason?: string;
}

export interface AoiEnvironmentSourceRegistry {
  version: 1;
  sessionPath: string;
  sources: AoiEnvironmentSource[];
  updatedAt: number;
}

export interface AoiEnvironmentSourcePolicyCheckResult {
  allowed: boolean;
  reasons: string[];
  source?: AoiEnvironmentSource;
}

export type AoiProposalStatus =
  | 'active'
  | 'accepted'
  | 'dismissed'
  | 'snoozed'
  | 'expired'
  | 'executed'
  | 'blocked';

export type AoiObservationSource =
  | 'chat'
  | 'tool'
  | 'research_run'
  | 'kira'
  | 'proposal'
  | 'memory'
  | 'workspace'
  | 'app'
  | 'system';

export type AoiReflectionKind =
  | 'memory_audit'
  | 'failure_postmortem'
  | 'opportunity'
  | 'procedure_candidate';

export type AoiProposalDecisionAction = 'accept' | 'dismiss' | 'snooze' | 'execute' | 'block';

export type AoiProposalFeedbackCategory =
  | 'useful'
  | 'not_useful'
  | 'wrong_memory'
  | 'wrong_evidence'
  | 'stale'
  | 'too_frequent'
  | 'too_much'
  | 'wrong_timing'
  | 'unsafe'
  | 'already_done'
  | 'needs_more_detail';

export type AoiFailureKind =
  | 'policy_blocked'
  | 'missing_evidence'
  | 'scope_too_broad'
  | 'stale_confirmation'
  | 'research_failed'
  | 'research_insufficient_sources'
  | 'kira_needs_clarification'
  | 'kira_validation_failed'
  | 'kira_review_blocked'
  | 'execution_exception';

export type AoiRecoveryActionKind =
  | 'ask_clarification'
  | 'narrow_scope'
  | 'refresh_research'
  | 'prepare_kira_followup'
  | 'pause_mission'
  | 'mark_blocked';

export type AoiAutonomyTickReason =
  | 'manual'
  | 'turn'
  | 'periodic'
  | 'research_run'
  | 'kira'
  | 'proposal'
  | 'memory'
  | 'app';

export type AoiAutonomyWakeupReason =
  | 'session_open'
  | 'user_return_idle'
  | 'manual_refresh'
  | 'source_ttl_expired'
  | 'mission_waiting_too_long'
  | 'kira_event'
  | 'research_event'
  | 'health_check';

export type AoiAttentionEventKind =
  | 'kira_work_status_changed'
  | 'kira_needs_clarification'
  | 'kira_completed_reviewed_work'
  | 'research_completed'
  | 'research_failed_or_insufficient'
  | 'workspace_validation_stale'
  | 'active_goal_waiting_too_long'
  | 'user_returned_after_idle'
  | 'proposal_feedback_trust_changed';

export type AoiAttentionLevel = 'silent' | 'badge' | 'inline' | 'direct';

export type AoiAttentionBrokerDecisionKind =
  | 'ignore'
  | 'record_observation_only'
  | 'update_mission_state'
  | 'show_dashboard_badge'
  | 'create_proposal'
  | 'ask_direct_clarification';

export interface AoiAttentionEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiAttentionEventKind;
  sourceRef: string;
  sourceSignature: string;
  summary: string;
  risk: AoiAutonomyRisk;
  evidenceRefs: string[];
  suggestedAttentionLevel: AoiAttentionLevel;
  createdAt: number;
  dedupeKey: string;
}

export interface AoiAttentionBrokerDecision {
  version: 1;
  eventId: string;
  kind: AoiAttentionBrokerDecisionKind;
  reason: string;
  score: number;
  createdAt: number;
  observationId?: string;
  proposalId?: string;
}

export type AoiNotificationLane =
  | 'critical_user_blocking'
  | 'needs_approval'
  | 'mission_update'
  | 'fyi'
  | 'hidden_by_quiet_mode';

export interface AoiQuietWindow {
  version: 1;
  enabled: boolean;
  reason: string;
  startedAt?: number;
  endsAt?: number;
  hiddenLane: AoiNotificationLane;
}

export type AoiDigestItemKind =
  | 'mission_status'
  | 'source_change'
  | 'kira_outcome'
  | 'research_outcome'
  | 'stale_validation'
  | 'pending_approval'
  | 'blocked_item';

export interface AoiDigestItem {
  version: 1;
  id: string;
  kind: AoiDigestItemKind;
  lane: AoiNotificationLane;
  title: string;
  summary: string;
  nextSafeAction: string;
  risk: AoiAutonomyRisk;
  relevance: number;
  createdAt: number;
  dedupeKey: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  hidden: boolean;
}

export interface AoiApprovalInboxItem {
  version: 1;
  proposalId: string;
  title: string;
  exactNextAction: string;
  boundary: string;
  risk: AoiAutonomyRisk;
  status: AoiProposalStatus;
  actionKind?: AoiProposalAcceptActionKind;
  requiredAutonomyLevel: AoiAutonomyLevel;
  evidenceCount: number;
  evidenceRefs: string[];
  dedupeKey: string;
  createdAt: number;
  availableActions: Array<'approve' | 'dismiss' | 'snooze' | 'details'>;
}

export interface AoiResumeBrief {
  version: 1;
  id: string;
  visible: boolean;
  title: string;
  whatChanged: string;
  nextSafeAction: string;
  safetyBoundary: string;
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiOperatorDigest {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  summary: string;
  quietWindow?: AoiQuietWindow;
  items: AoiDigestItem[];
  approvalInbox: AoiApprovalInboxItem[];
  resumeBrief?: AoiResumeBrief;
  laneCounts: Record<AoiNotificationLane, number>;
  hiddenItemCount: number;
  evidenceRefs: string[];
}

export type AoiOperatorTimelineEventKind =
  | 'observation_ingested'
  | 'source_selected'
  | 'source_suppressed'
  | 'proposal_created'
  | 'proposal_blocked'
  | 'proposal_accepted'
  | 'proposal_dismissed'
  | 'proposal_snoozed'
  | 'proposal_executed'
  | 'proposal_failed'
  | 'mission_state_changed'
  | 'goal_state_changed'
  | 'digest_item_surfaced'
  | 'digest_item_hidden'
  | 'approved_command_previewed'
  | 'approved_command_recorded'
  | 'feedback_recorded'
  | 'wakeup_recorded'
  | 'trace_exported';

export type AoiOperatorTimelineVisibility =
  | 'operator_visible'
  | 'dashboard_only'
  | 'hidden'
  | 'redacted';

export type AoiTraceRedactionState = 'none' | 'redacted' | 'synthetic' | 'removed';

export interface AoiOperatorTimelineEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiOperatorTimelineEventKind;
  visibility: AoiOperatorTimelineVisibility;
  createdAt: number;
  title: string;
  summary: string;
  redactionState: AoiTraceRedactionState;
  evidenceRefs: string[];
  relatedRefs: string[];
  sourceRef?: string;
  sourceKind?: string;
  proposalId?: string;
  decisionId?: string;
  goalId?: string;
  missionId?: string;
  digestItemId?: string;
  commandAuditId?: string;
  triggerKind?: string;
  actionKind?: string;
  status?: string;
  risk?: AoiAutonomyRisk;
  metrics?: Record<string, number>;
  metadata?: Record<string, string | number | boolean | string[]>;
}

export interface AoiTraceRedactionSummary {
  totalReplacementCount: number;
  localPathCount: number;
  urlCount: number;
  emailCount: number;
  privateFieldCount: number;
  syntheticLabels: Record<string, string>;
}

export interface AoiOperatorTraceExport {
  version: 1;
  id: string;
  sessionPath: string;
  exportedAt: number;
  eventCount: number;
  sourceEventIds: string[];
  events: AoiOperatorTimelineEvent[];
  redactionSummary: AoiTraceRedactionSummary;
  privacyNotes: string[];
}

export interface AoiOperatorReplayFixtureDraft {
  version: 1;
  traceExportId: string;
  fixtureId: string;
  title: string;
  todoExpectations: string[];
  warnings: string[];
}

export interface AoiOperatorTimelineSummary {
  version: 1;
  sessionPath: string;
  newestMeaningfulEvents: AoiOperatorTimelineEvent[];
  newestEventAt?: number;
  lastExportAt?: number;
  lastExportRedactionCount: number;
  totalEventCount: number;
  exportedTraceCount: number;
}

export interface AoiAutonomyWakeupBudget {
  version: 1;
  maxSchedulerRuntimeMs: number;
  maxBackgroundTickRuntimeMs: number;
  maxSourceCount: number;
  maxGeneratedProposalCount: number;
  perSourceCooldownMs: number;
  wakeupCooldownMs: number;
  quietMode: boolean;
  allowNetwork: boolean;
}

export type AoiAutonomySourceScheduleResult = 'refreshed' | 'skipped' | 'failed';

export interface AoiAutonomySourceSchedule {
  version: 1;
  sourceId: string;
  operation: AoiEnvironmentSourceOperation;
  ttlMs: number;
  cooldownMs: number;
  nextAllowedAt?: number;
  lastRefreshedAt?: number;
  lastSkippedAt?: number;
  lastResult?: AoiAutonomySourceScheduleResult;
  lastReasons: string[];
  refreshCount: number;
  skipCount: number;
  updatedAt: number;
}

export interface AoiAutonomyWakeupSkippedSource {
  sourceId: string;
  reasons: string[];
}

export interface AoiAutonomyWakeupRecord {
  version: 1;
  id: string;
  sessionPath: string;
  reason: AoiAutonomyWakeupReason;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  ok: boolean;
  status: 'completed' | 'skipped' | 'failed';
  budget: AoiAutonomyWakeupBudget;
  selectedSourceIds: string[];
  refreshedSourceIds: string[];
  skippedSources: AoiAutonomyWakeupSkippedSource[];
  tickRan: boolean;
  tickSkipped: boolean;
  tickOk: boolean;
  tickReason: AoiAutonomyTickReason;
  proposalsCreated: number;
  observationsSeen: number;
  warnings: string[];
}

export interface AoiAutonomySchedulerState {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  wakeupCount: number;
  lastWakeupAt?: number;
  lastWakeupReason?: AoiAutonomyWakeupReason;
  lastWakeupStatus?: AoiAutonomyWakeupRecord['status'];
  nextAllowedWakeupAt?: number;
  sourceSchedules: AoiAutonomySourceSchedule[];
  recentWakeups: AoiAutonomyWakeupRecord[];
}

export interface AoiAutonomyWakeupResult {
  ok: boolean;
  sessionPath: string;
  record: AoiAutonomyWakeupRecord;
  state: AoiAutonomySchedulerState;
  status: AoiAutonomyStatus;
  tickResult?: AoiAutonomyTickResult;
}

export type AoiKiraOutcomeKind =
  | 'kira_work_completed'
  | 'kira_work_blocked'
  | 'kira_needs_clarification'
  | 'kira_validation_failed'
  | 'kira_review_rejected'
  | 'kira_integrated';

export interface AoiKiraOutcomeEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiKiraOutcomeKind;
  workId: string;
  workRef: string;
  workTitle: string;
  projectName: string;
  attemptId?: string;
  attemptNo?: number;
  reviewId?: string;
  sourceProposalId?: string;
  sourceGoalId?: string;
  sourcePlanStepId?: string;
  validationSummary: string;
  changedFilesSummary: string;
  evidenceRefs: string[];
  reviewApproved?: boolean;
  validationPassed: boolean;
  integrated: boolean;
  reviewerNotes: string[];
  createdAt: number;
  dedupeKey: string;
}

export type AoiProposalAcceptActionKind =
  | 'open_research_artifact'
  | 'read_research_artifact'
  | 'get_research_status'
  | 'start_research'
  | 'create_kira_work'
  | 'run_command'
  | 'open_app'
  | 'save_memory'
  | 'activate_goal';

export interface AoiProposalAcceptAction {
  kind: AoiProposalAcceptActionKind;
  params: Record<string, unknown>;
}

export type AoiPreparedActionPlanStatus = 'ready' | 'blocked';

export type AoiCheckpointPlanKind =
  | 'existing_git_state'
  | 'kira_isolated_worktree'
  | 'manual_checkpoint_required'
  | 'not_applicable';

export type AoiRollbackPlanKind =
  | 'kira_review_reject_or_revert'
  | 'research_cancel_or_ignore'
  | 'validation_only_no_mutation'
  | 'manual_revert_required'
  | 'not_applicable';

export type AoiRollbackGuarantee = 'none' | 'best_effort' | 'mechanism_backed';

export interface AoiActionRisk {
  level: AoiAutonomyRisk;
  mutationCapable: boolean;
  commandCapable: boolean;
  reasons: string[];
}

export interface AoiCheckpointPlan {
  kind: AoiCheckpointPlanKind;
  required: boolean;
  available: boolean;
  summary: string;
  instructions: string[];
  evidenceRefs: string[];
  missingReason?: string;
}

export interface AoiRollbackPlan {
  kind: AoiRollbackPlanKind;
  available: boolean;
  guarantee: AoiRollbackGuarantee;
  summary: string;
  instructions: string[];
  evidenceRefs: string[];
}

export interface AoiValidationPlan {
  required: boolean;
  approvalRequiredBeforeRun: boolean;
  summary: string;
  commands: string[];
  expectedEvidenceRefs: string[];
}

export interface AoiApprovalRequirement {
  required: boolean;
  requiredLevel: AoiAutonomyLevel;
  freshAcceptanceRequired: boolean;
  approver: 'user' | 'kira_reviewer' | 'none';
  reason: string;
}

export interface AoiPreparedActionPlan {
  version: 1;
  status: AoiPreparedActionPlanStatus;
  actionKind: string;
  objective: string;
  expectedChanges: string[];
  affectedSurfaces: string[];
  evidenceRefs: string[];
  risk: AoiActionRisk;
  approval: AoiApprovalRequirement;
  checkpoint: AoiCheckpointPlan;
  rollback: AoiRollbackPlan;
  validation: AoiValidationPlan;
  blockers: string[];
  nonGoals: string[];
}

export type AoiCommandBlockReason =
  | 'missing_command'
  | 'command_too_long'
  | 'cwd_not_relative'
  | 'cwd_escapes_workspace'
  | 'shell_metacharacters'
  | 'unsupported_program'
  | 'unsupported_pnpm_shape'
  | 'untargeted_test_command'
  | 'unsafe_test_target'
  | 'unsupported_git_shape'
  | 'unsafe_git_argument'
  | 'destructive_file_operation'
  | 'package_install_or_update'
  | 'credential_or_secret_command'
  | 'network_mutation_command'
  | 'background_process_launch'
  | 'interactive_shell'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_command_changed'
  | 'approval_cwd_changed'
  | 'approval_risk_changed'
  | 'approval_purpose_changed'
  | 'workspace_cwd_missing'
  | 'execution_failed'
  | 'execution_timeout';

export interface AoiApprovedCommandRequest {
  version: 1;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  command: string;
  cwd: string;
  purpose: string;
  risk: AoiAutonomyRisk;
  timeoutMs: number;
  requestedAt: number;
  evidenceRefs: string[];
}

export interface AoiApprovedCommandPolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiCommandBlockReason[];
  command: string;
  displayCommand: string;
  program?: 'git' | 'pnpm';
  args: string[];
  cwd: string;
  cwdLabel: string;
  cwdHash: string;
  purpose: string;
  purposeHash: string;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: 'L5';
  timeoutMs: number;
  approvalFingerprint: string;
  expiresAt: number;
  rationale: string[];
}

export interface AoiCommandAuditRecord {
  version: 1;
  id: string;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  command: string;
  cwdLabel: string;
  cwdHash: string;
  purpose: string;
  risk: AoiAutonomyRisk;
  allowed: boolean;
  blockReasons: AoiCommandBlockReason[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  evidenceRefs: string[];
  approvalFingerprint: string;
}

export interface AoiApprovedCommandResult {
  version: 1;
  ok: boolean;
  command: string;
  cwdLabel: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  auditRecord: AoiCommandAuditRecord;
  evidenceRefs: string[];
}

export interface AoiRecoveryPreviewAction {
  kind: AoiRecoveryActionKind;
  label: string;
  reason: string;
}

export interface AoiRecoveryPreview {
  version: 1;
  failureKind: AoiFailureKind;
  rootCauseSummary: string;
  evidenceRefs: string[];
  proposedAction: AoiRecoveryPreviewAction;
  whyNarrowerOrSafer: string;
  retryCount: number;
  maxRetryCount: number;
  cooldownActive: boolean;
  sourceRef: string;
  failureSignature: string;
  nonGoals: string[];
  cooldownUntil?: number;
  blockedReason?: string;
}

export interface AoiObservation {
  version: 1;
  id: string;
  source: AoiObservationSource;
  sessionPath: string;
  createdAt: number;
  summary: string;
  payloadRef?: string;
  memoryIds: string[];
  artifactRefs: string[];
  proposalIds: string[];
  riskSignals: string[];
  dedupeKey: string;
}

export interface AoiObservationIndexEntry {
  id: string;
  dedupeKey: string;
  source: AoiObservationSource;
  createdAt: number;
  summary: string;
}

export interface AoiObservationIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiObservationIndexEntry[];
}

export interface AoiReflection {
  version: 1;
  id: string;
  observationIds: string[];
  sessionPath: string;
  createdAt: number;
  kind: AoiReflectionKind;
  claim: string;
  evidenceRefs: string[];
  confidence: number;
  risk: AoiAutonomyRisk;
  proposedMemoryCandidates: string[];
  proposedActions: string[];
}

export interface AoiProposal {
  version: 1;
  id: string;
  sessionPath: string;
  status: AoiProposalStatus;
  title: string;
  body: string;
  reason: string;
  trigger: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  snoozedUntil?: number;
  cooldownKey: string;
  confidence: number;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: AoiAutonomyLevel;
  requiresUserApproval: boolean;
  suggestedTools: string[];
  evidenceRefs: string[];
  memoryIds: string[];
  artifactRefs: string[];
  riskSignals: string[];
  acceptAction?: AoiProposalAcceptAction;
  recoveryPreview?: AoiRecoveryPreview;
  blockedReason?: string;
}

export type AoiGoalStatus =
  | 'proposed'
  | 'active'
  | 'paused'
  | 'completed'
  | 'abandoned'
  | 'blocked';

export type AoiGoalOwner = 'user' | 'aoi' | 'shared';

export type AoiPlanStepKind =
  | 'read'
  | 'research'
  | 'draft'
  | 'review'
  | 'execute_proposal'
  | 'ask_user'
  | 'handoff_kira';

export type AoiPlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface AoiPlanStep {
  version: 1;
  id: string;
  kind: AoiPlanStepKind;
  title: string;
  status: AoiPlanStepStatus;
  expectedEvidence: string[];
  allowedActionKind: AoiProposalAcceptActionKind | 'none';
  requiredAutonomyLevel: AoiAutonomyLevel;
  doneCriteria: string[];
  evidenceRefs: string[];
  risk: AoiAutonomyRisk;
}

export interface AoiPlan {
  version: 1;
  id: string;
  goalId: string;
  sessionPath: string;
  createdAt: number;
  updatedAt: number;
  sourceRefs: string[];
  steps: AoiPlanStep[];
}

export interface AoiGoal {
  version: 1;
  id: string;
  sessionPath: string;
  title: string;
  userIntentSummary: string;
  sourceRefs: string[];
  status: AoiGoalStatus;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number;
  confidence: number;
  risk: AoiAutonomyRisk;
  owner: AoiGoalOwner;
  plan: AoiPlan;
}

export interface AoiGoalProgressEvent {
  version: 1;
  id: string;
  goalId: string;
  sessionPath: string;
  createdAt: number;
  kind:
    | 'proposed'
    | 'activated'
    | 'progress'
    | 'blocked'
    | 'completed'
    | 'abandoned'
    | 'paused'
    | 'resumed'
    | 'continuation_proposed';
  summary: string;
  evidenceRefs: string[];
  observationIds: string[];
  proposalIds: string[];
  planStepId?: string;
  fromStatus?: AoiGoalStatus;
  toStatus?: AoiGoalStatus;
}

export type AoiMissionStatus =
  | 'none'
  | 'active'
  | 'waiting_on_user'
  | 'waiting_on_kira'
  | 'waiting_on_research'
  | 'paused'
  | 'completed'
  | 'blocked';

export type AoiAutonomyVisibleState =
  | 'preview_ready'
  | 'waiting_for_approval'
  | 'delegated_to_kira'
  | 'waiting_on_user'
  | 'waiting_on_research'
  | 'paused'
  | 'blocked'
  | 'completed';

export type AoiMissionWaitingOn = 'none' | 'aoi' | 'user' | 'kira' | 'research';

export type AoiMissionRecommendedActionKind =
  | 'none'
  | 'review_goal'
  | 'answer_user'
  | 'wait_for_user'
  | 'inspect_kira'
  | 'inspect_research'
  | 'prepare_research'
  | 'prepare_kira'
  | 'prepare_validation'
  | 'resume_mission';

export interface AoiMissionRecommendedAction {
  kind: AoiMissionRecommendedActionKind;
  label: string;
  reason: string;
  ref?: string;
}

export interface AoiMissionSourceRefs {
  goalRef?: string;
  planStepRef?: string;
  proposalRef?: string;
  decisionRef?: string;
  observationRef?: string;
  researchRunRef?: string;
  kiraWorkRef?: string;
  workspaceSnapshotRef?: string;
  validationRef?: string;
}

export type AoiSignalFreshness = 'unknown' | 'fresh' | 'stale' | 'failed';

export type AoiValidationSignalResult = 'unknown' | 'passed' | 'failed';

export interface AoiChangedFileSignal {
  version: 1;
  pathLabel: string;
  pathHash: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  changedAt?: number;
  directoryLabel?: string;
  extension?: string;
}

export interface AoiGitSignal {
  version: 1;
  branchName: string;
  previousBranchName?: string;
  branchChanged: boolean;
  isDirty: boolean;
  changedFileCount: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  statusSummary: string;
  changedFiles: AoiChangedFileSignal[];
  recentCommitHash?: string;
  recentCommitMessage?: string;
  error?: string;
}

export interface AoiValidationSignal {
  version: 1;
  command?: string;
  result: AoiValidationSignalResult;
  completedAt?: number;
  touchedFileScopes: string[];
  freshness: AoiSignalFreshness;
  staleReason?: string;
  evidenceRefs: string[];
}

export interface AoiWorkspaceSnapshot {
  version: 1;
  sessionPath: string;
  collectedAt: number;
  workspaceLabel: string;
  sourceIds: string[];
  git?: AoiGitSignal;
  validation: AoiValidationSignal;
  freshness: AoiSignalFreshness;
  evidenceRefs: string[];
  warnings: string[];
}

export type AoiContextSourceKind = AoiEnvironmentSourceKind | 'mission_state';

export type AoiContextRedactionState = 'none' | 'redacted' | 'withheld';

export interface AoiContextSourceSummary {
  version: 1;
  id: string;
  sourceId: string;
  kind: AoiContextSourceKind;
  label: string;
  displayName?: string;
  relevanceScore: number;
  confidence: number;
  freshness: AoiSignalFreshness;
  redactionState: AoiContextRedactionState;
  summary: string;
  evidenceRefs: string[];
  scoreReasons: string[];
  updatedAt: number;
  staleReason?: string;
}

export interface AoiBrowserContextMetadata {
  version: 1;
  id: string;
  sessionPath: string;
  pageTitle: string;
  urlHost: string;
  redactedUrl: string;
  purpose: string;
  capturedAt: number;
  evidenceRefs: string[];
  redactionState: AoiContextRedactionState;
}

export interface AoiContextSourceFeedback {
  version: 1;
  id: string;
  sessionPath: string;
  sourceId: string;
  contextSummaryId?: string;
  feedbackCategory: AoiProposalFeedbackCategory;
  feedbackNote?: string;
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiContextRouterResult {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  selectedSources: AoiContextSourceSummary[];
  candidateSources: AoiContextSourceSummary[];
  promptBlock: string;
}

export interface AoiMissionTransitionRef {
  from: AoiMissionStatus;
  to: AoiMissionStatus;
  createdAt: number;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiMissionState {
  version: 1;
  sessionPath: string;
  status: AoiMissionStatus;
  activeGoalId?: string;
  focusSummary: string;
  waitingOn: AoiMissionWaitingOn;
  lastMeaningfulEventRef?: string;
  nextRecommendedAction: AoiMissionRecommendedAction;
  evidenceRefs: string[];
  sourceRefs: AoiMissionSourceRefs;
  transitions: AoiMissionTransitionRef[];
  createdAt: number;
  updatedAt: number;
  pausedAt?: number;
  blockedReason?: string;
}

export type AoiMissionDecisionAction = 'pause' | 'resume' | 'clear' | 'complete' | 'block';

export interface AoiProposalDecision {
  version: 1;
  id: string;
  proposalId: string;
  sessionPath: string;
  cooldownKey: string;
  action: AoiProposalDecisionAction;
  actor: 'user' | 'system';
  createdAt: number;
  previousStatus: AoiProposalStatus;
  nextStatus: AoiProposalStatus;
  reason?: string;
  feedbackCategory?: AoiProposalFeedbackCategory;
  feedbackNote?: string;
  snoozedUntil?: number;
  proposalTrigger?: string;
  proposalRisk?: AoiAutonomyRisk;
  actionKind?: AoiProposalAcceptActionKind;
  suggestedTools?: string[];
  evidenceRefs?: string[];
  memoryIds?: string[];
  approvedCommand?: AoiApprovedCommandPolicy;
}

export interface AoiAutonomyToolPolicy {
  toolName: string;
  maxLevel: AoiAutonomyLevel;
  requiresApproval: boolean;
  blocked?: boolean;
}

export interface AoiAutonomyPolicy {
  version: 1;
  enabled: boolean;
  previewMode: boolean;
  level: AoiAutonomyLevel;
  proactiveSuggestionsEnabled: boolean;
  confidenceFloor: number;
  maxActiveProposals: number;
  maxProposalsPerTick: number;
  maxProposalsPerDay: number;
  defaultCooldownMs: number;
  defaultSnoozeMs: number;
  duplicateCheckEnabled: boolean;
  cooldownCheckEnabled: boolean;
  requireEvidenceRefs: boolean;
  requireApprovalForHighRisk: boolean;
  updatedAt: number;
}

export interface AoiAutonomyStatus {
  version: 1;
  sessionPath: string;
  policy: AoiAutonomyPolicy;
  activeProposalCount: number;
  archivedProposalCount: number;
  acceptedProposalCount: number;
  snoozedProposalCount: number;
  blockedProposalCount: number;
  observationCount: number;
  reflectionCount: number;
  decisionCount: number;
  lastDecisionAt?: number;
  lastObservationAt?: number;
  lastReflectionAt?: number;
  lastTickAt?: number;
  nextAllowedTickAt?: number;
  lastTickReason?: AoiAutonomyTickReason;
  activeTick: boolean;
  recentObservationCount: number;
  proposalsCreatedInLastTick: number;
  activeGoalCount: number;
  currentGoalTitle?: string;
  nextGoalStepTitle?: string;
  environmentSourceCount?: number;
  enabledEnvironmentSourceCount?: number;
  highRiskEnvironmentSourceCount?: number;
  privateEnvironmentSourceCount?: number;
  lastEnvironmentSourceObservedAt?: number;
  updatedAt: number;
}

export interface AoiAutonomyTickState {
  version: 1;
  sessionPath: string;
  activeTick: boolean;
  activeTickId?: string;
  activeTickReason?: AoiAutonomyTickReason;
  lockExpiresAt?: number;
  lastTickAt?: number;
  lastTickReason?: AoiAutonomyTickReason;
  lastTickStartedAt?: number;
  lastTickCompletedAt?: number;
  nextAllowedTickAt?: number;
  recentObservationCount: number;
  proposalsCreatedInLastTick: number;
  lastSkippedReason?: string;
  updatedAt: number;
}

export interface AoiProposalPolicyCheckInput {
  policy: AoiAutonomyPolicy;
  proposal: AoiProposal;
  activeProposals?: AoiProposal[];
  recentDecisions?: AoiProposalDecision[];
  now?: number;
}

export interface AoiProposalPolicyCheckResult {
  allowed: boolean;
  reasons: string[];
}

export interface AoiAutonomyBlockedProposal {
  proposalId: string;
  title: string;
  reasons: string[];
  evidenceRefs: string[];
  actionKind?: AoiProposalAcceptActionKind;
  requiredAutonomyLevel?: AoiAutonomyLevel;
  requiresUserApproval?: boolean;
  risk?: AoiAutonomyRisk;
  safeAlternative?: string;
}

export interface AoiAutonomyTickResult {
  ok: boolean;
  sessionPath: string;
  reason: AoiAutonomyTickReason;
  status: AoiAutonomyStatus;
  tickState: AoiAutonomyTickState;
  skipped: boolean;
  newObservationCount: number;
  newReflectionCount: number;
  newActiveProposalCount: number;
  blockedProposalCount: number;
  blockedProposals: AoiAutonomyBlockedProposal[];
  operatorDigest?: AoiOperatorDigest;
  warnings: string[];
}

export interface AoiProposalExecutionPolicyContext {
  now?: number;
  decisions?: AoiProposalDecision[];
  decisionId?: string;
  freshAcceptanceMs?: number;
  executionMode?: 'preview' | 'execute';
}

export interface AoiProposalExecutionPolicyResult {
  allowed: boolean;
  reasons: string[];
  actionKind?: string;
  toolName?: string;
  requiresFreshAcceptance: boolean;
  readOnly: boolean;
  safeAlternative?: string;
}
