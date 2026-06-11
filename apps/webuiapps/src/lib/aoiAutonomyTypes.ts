export type AoiAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AoiAutonomyRisk = 'low' | 'medium' | 'high';

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
  | 'stale'
  | 'too_frequent'
  | 'unsafe'
  | 'already_done'
  | 'needs_more_detail';

export type AoiAutonomyTickReason =
  | 'manual'
  | 'turn'
  | 'periodic'
  | 'research_run'
  | 'kira'
  | 'proposal'
  | 'memory'
  | 'app';

export type AoiProposalAcceptActionKind =
  | 'open_research_artifact'
  | 'read_research_artifact'
  | 'get_research_status'
  | 'start_research'
  | 'create_kira_work'
  | 'open_app'
  | 'save_memory'
  | 'activate_goal';

export interface AoiProposalAcceptAction {
  kind: AoiProposalAcceptActionKind;
  params: Record<string, unknown>;
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
  warnings: string[];
}

export interface AoiProposalExecutionPolicyContext {
  now?: number;
  decisions?: AoiProposalDecision[];
  decisionId?: string;
  freshAcceptanceMs?: number;
}

export interface AoiProposalExecutionPolicyResult {
  allowed: boolean;
  reasons: string[];
  actionKind?: string;
  toolName?: string;
  requiresFreshAcceptance: boolean;
  readOnly: boolean;
}
