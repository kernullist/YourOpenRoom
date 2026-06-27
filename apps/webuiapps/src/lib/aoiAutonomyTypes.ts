import type { AoiBoundedWorkOrder } from './aoiBoundedWorkOrder';
import type { AoiActionCheckpoint } from './aoiActionCheckpoint';
import type { AoiMcpConnectorsConfig } from './aoiMcpConnectorRegistry';
import type { AppIntentExecutionKind } from './appIntentContracts';
import type {
  AoiApprovalSandboxPreview,
  AoiApprovalSandboxValidationResult,
} from './aoiApprovalSandbox';

export type AoiAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AoiAutonomyRisk = 'low' | 'medium' | 'high';

export type AoiPersonalSignalSourceKind = 'calendar_metadata' | 'gmail_metadata' | 'notes_metadata';

export type AoiEnvironmentSourceKind =
  | 'workspace_git'
  | 'workspace_build'
  | 'kira_board'
  | 'research_runs'
  | 'app_state'
  | 'browser_context'
  | 'manual_note'
  | AoiPersonalSignalSourceKind;

export type AoiEnvironmentSourceOperation =
  | 'summarize'
  | 'status'
  | 'diff'
  | 'read_metadata'
  | 'summarize_counts';

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
  lastReviewedAt?: number;
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

export type AoiOpportunitySourceKind =
  | 'memory'
  | 'interest'
  | 'workspace'
  | 'kira'
  | 'research'
  | 'app_state'
  | 'agenda'
  | 'manual';

export type AoiOpportunityDeliveryRecommendation =
  | 'dashboard'
  | 'inline_card'
  | 'quiet_notification'
  | 'direct_chat';

export type AoiOpportunityStatus =
  | 'active'
  | 'accepted'
  | 'dismissed'
  | 'snoozed'
  | 'converted'
  | 'expired'
  | 'archived';

export interface AoiOpportunity {
  version: 1;
  id: string;
  sessionPath: string;
  sourceKind: AoiOpportunitySourceKind;
  title: string;
  curiosityQuestion: string;
  whyNow: string;
  evidenceNeed: string;
  suggestedNextAction: string;
  risk: AoiAutonomyRisk;
  confidence: number;
  urgency: number;
  novelty: number;
  deliveryRecommendation: AoiOpportunityDeliveryRecommendation;
  status: AoiOpportunityStatus;
  evidenceRefs: string[];
  dedupeKey: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  snoozedUntil?: number;
  archivedAt?: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export type AoiFollowThroughAction =
  | 'accepted'
  | 'dismissed'
  | 'snoozed'
  | 'executed'
  | 'blocked'
  | 'failed'
  | 'ignored';

export type AoiFollowThroughResult =
  | 'positive'
  | 'negative'
  | 'neutral'
  | 'soft_negative'
  | 'blocked'
  | 'failed';

export type AoiLearningSignalKind = 'explicit_label' | 'explicit_correction' | 'passive_outcome';

export type AoiOutcomeSignalKind =
  | 'proposal_opened'
  | 'proposal_ignored'
  | 'direct_chat_dismissed'
  | 'work_order_approved'
  | 'work_order_rejected'
  | 'validation_run'
  | 'commit_created'
  | 'user_correction';

export type AoiOutcomePrivacyState = 'metadata_only' | 'redacted' | 'synthetic' | 'unknown';

export type AoiOutcomeLearningDirection = 'boost' | 'suppress' | 'neutral' | 'risk_up';

export type AoiOutcomeLearningTarget =
  | 'topic'
  | 'source'
  | 'timing'
  | 'readiness'
  | 'trust'
  | 'safety';

export interface AoiOutcomeLearningAdjustment {
  version: 1;
  target: AoiOutcomeLearningTarget;
  direction: AoiOutcomeLearningDirection;
  magnitude: number;
  reason: string;
}

export interface AoiOutcomeSignalRecord {
  version: 1;
  id: string;
  sessionPath: string;
  eventId: string;
  sourceProposalId?: string;
  sourceDecisionId?: string;
  sourceWorkOrderId?: string;
  sourceValidationRef?: string;
  sourceCommitRef?: string;
  sourceChatRef?: string;
  outcomeKind: AoiOutcomeSignalKind;
  signalKind: AoiLearningSignalKind;
  confidence: number;
  inferredAdjustment: AoiOutcomeLearningAdjustment;
  explicitLabelRef?: string;
  explicitLabel?: string;
  topicKey?: string;
  sourceKey?: string;
  deliveryMode?: AoiFollowThroughDeliveryMode;
  result: AoiFollowThroughResult;
  evidenceRefs: string[];
  privacyState: AoiOutcomePrivacyState;
  createdAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiOutcomeLearningSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  outcomeCount: number;
  explicitLabelLinkedCount: number;
  explicitCorrectionCount: number;
  passiveOutcomeCount: number;
  outcomeOnly: boolean;
  trustIncreaseAllowed: boolean;
  trustIncreaseBlockedReasons: string[];
  kindConfidenceLabels: string[];
  learningEffectLabels: string[];
  previousSuggestionOutcomeLabels: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export type AoiFollowThroughDeliveryMode =
  | AoiOpportunityDeliveryRecommendation
  | 'digest'
  | 'chat_hook'
  | 'hidden'
  | 'blocked'
  | 'unknown';

export interface AoiFollowThroughEvent {
  version: 1;
  id: string;
  sessionPath: string;
  opportunityId: string;
  proposalId?: string;
  deliberationRunId?: string;
  sourceKind?:
    | AoiOpportunitySourceKind
    | 'deliberation'
    | 'proactive_brief'
    | 'proactive_trend'
    | 'proposal';
  topicKey?: string;
  sourceKey?: string;
  deliveryMode?: AoiFollowThroughDeliveryMode;
  action: AoiFollowThroughAction;
  feedbackCategory?: string;
  learningSignalKind?: AoiLearningSignalKind;
  outcomeSignalId?: string;
  outcomeKind?: AoiOutcomeSignalKind;
  confidence?: number;
  learningEffect?: AoiOutcomeLearningAdjustment;
  trustIncreaseEligible?: boolean;
  result: AoiFollowThroughResult;
  timingLabel: string;
  evidenceRefs: string[];
  createdAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFollowThroughLearningAdjustment {
  key: string;
  label: string;
  score: number;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiFollowThroughDeliverySensitivity {
  mode: AoiFollowThroughDeliveryMode;
  factor: number;
  cooldownMs: number;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiFollowThroughCooldownAdjustment {
  key: string;
  factor: number;
  nextEligibleAt?: number;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiFollowThroughLearningSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  eventCount: number;
  latestEventAt?: number;
  recentEvents: AoiFollowThroughEvent[];
  latestByOpportunityId: Record<string, AoiFollowThroughEvent>;
  topicBoosts: AoiFollowThroughLearningAdjustment[];
  topicSuppressions: AoiFollowThroughLearningAdjustment[];
  sourceBoosts: AoiFollowThroughLearningAdjustment[];
  sourceSuppressions: AoiFollowThroughLearningAdjustment[];
  deliveryModeSensitivity: AoiFollowThroughDeliverySensitivity[];
  duplicateCooldownAdjustments: AoiFollowThroughCooldownAdjustment[];
  trustCalibrationHints: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFollowThroughSummaryIndexEntry {
  key: string;
  kind: 'topic' | 'source' | 'delivery' | 'cooldown' | 'trust';
  direction: 'boost' | 'suppress' | 'neutral';
  score: number;
  reason: string;
  evidenceRefs: string[];
  updatedAt: number;
}

export interface AoiFollowThroughSummaryIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiFollowThroughSummaryIndexEntry[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export type AoiDeliberationPhase =
  | 'queued'
  | 'planning'
  | 'observing'
  | 'summarizing'
  | 'ready'
  | 'blocked'
  | 'failed';

export type AoiDeliberationEvidenceStepStatus =
  | 'pending'
  | 'observed'
  | 'missing'
  | 'stale'
  | 'blocked';

export type AoiDeliberationEvidenceStepKind =
  | 'opportunity'
  | 'memory'
  | 'research'
  | 'workspace'
  | 'kira'
  | 'proposal'
  | 'mission'
  | 'app_state'
  | 'unknown';

export interface AoiDeliberationEvidenceStep {
  version: 1;
  id: string;
  kind: AoiDeliberationEvidenceStepKind;
  status: AoiDeliberationEvidenceStepStatus;
  sourceRef: string;
  label: string;
  summary: string;
  freshness: AoiSignalFreshness;
  evidenceRefs: string[];
  cannotKnow: string[];
  blockers: string[];
  observedAt?: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiDeliberationFinding {
  version: 1;
  summary: string;
  sourceQuality: 'strong' | 'acceptable' | 'weak' | 'missing';
  freshness: AoiSignalFreshness;
  confidence: number;
  evidenceRefs: string[];
  blockers: string[];
  cannotKnow: string[];
  createdAt: number;
}

export interface AoiDeliberationOpinion {
  version: 1;
  stance: 'ready_to_brief' | 'needs_more_evidence' | 'abstain';
  summary: string;
  reason: string;
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiDeliberationPhaseTransition {
  from?: AoiDeliberationPhase;
  to: AoiDeliberationPhase;
  reason: string;
  createdAt: number;
  evidenceRefs: string[];
}

export interface AoiDeliberationRun {
  version: 1;
  id: string;
  sessionPath: string;
  opportunityId: string;
  opportunityDedupeKey: string;
  opportunityTitle: string;
  phase: AoiDeliberationPhase;
  selectedAt: number;
  updatedAt: number;
  evidencePlan: AoiDeliberationEvidenceStep[];
  finding?: AoiDeliberationFinding;
  opinion?: AoiDeliberationOpinion;
  safeNextAction: string;
  blockers: string[];
  evidenceRefs: string[];
  artifactRefs: string[];
  phaseHistory: AoiDeliberationPhaseTransition[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export type AoiInterruptionDeliveryMode =
  | 'hidden'
  | 'dashboard'
  | 'inline_card'
  | 'quiet_notification'
  | 'direct_chat';

export type AoiInterruptionBlockedReason =
  | 'policy_disabled'
  | 'proactive_suggestions_disabled'
  | 'opportunity_not_active'
  | 'opportunity_expired'
  | 'opportunity_snoozed'
  | 'low_confidence'
  | 'low_urgency'
  | 'low_novelty'
  | 'high_risk'
  | 'missing_evidence'
  | 'stale_source'
  | 'failed_evidence'
  | 'direct_chat_not_opted_in'
  | 'quiet_mode'
  | 'notifications_disabled'
  | 'inline_session_limit_reached'
  | 'direct_chat_session_limit_reached'
  | 'recent_interruption_budget'
  | 'duplicate_or_cooldown'
  | 'recent_negative_feedback'
  | 'too_frequent_feedback'
  | 'jarvis_governor_blocks_direct_chat'
  | 'trend_direct_chat_not_ready'
  | 'trend_duplicate_suppressed';

export interface AoiInterruptionGovernorDecision {
  version: 1;
  id: string;
  sessionPath: string;
  opportunityId: string;
  opportunityDedupeKey: string;
  requestedMode: AoiOpportunityDeliveryRecommendation;
  deliveryMode: AoiInterruptionDeliveryMode;
  directChatAllowed: boolean;
  score: number;
  blockedReasons: AoiInterruptionBlockedReason[];
  directChatBlockedReasons: AoiInterruptionBlockedReason[];
  evidenceRefs: string[];
  cooldownKey: string;
  nextEligibleAt?: number;
  modeLabel: string;
  summaryLabel: string;
  blockedReasonLabels: string[];
  safetyBoundaryLabel: string;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export type AoiActionLadderLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AoiActionLadderExistingGate =
  | 'none'
  | 'opportunity_inbox'
  | 'interruption_governor'
  | 'deliberation_run'
  | 'proposal_acceptance'
  | 'research_gate'
  | 'kira_handoff'
  | 'safe_action_plan'
  | 'bounded_work_order'
  | 'approved_command_policy'
  | 'autonomy_execution';

export interface AoiActionLadderAction {
  version: 1;
  level: AoiActionLadderLevel;
  kind: string;
  label: string;
  existingGate: AoiActionLadderExistingGate;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiActionLadderBlockedAction {
  version: 1;
  level: AoiActionLadderLevel;
  kind: string;
  label: string;
  reason: string;
  existingGate: AoiActionLadderExistingGate;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiActionLadderApprovalNeed {
  version: 1;
  level: AoiActionLadderLevel;
  label: string;
  requiredAutonomyLevel?: AoiAutonomyLevel;
  approvalRef?: string;
  approvalFingerprint?: string;
  reason: string;
  satisfied: boolean;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiActionLadderDecision {
  version: 1;
  id: string;
  sessionPath: string;
  opportunityId: string;
  opportunityDedupeKey: string;
  currentLevel: AoiActionLadderLevel;
  nextLevel?: AoiActionLadderLevel;
  levelLabel: string;
  nextLevelLabel?: string;
  summaryLabel: string;
  allowedActions: AoiActionLadderAction[];
  blockedActions: AoiActionLadderBlockedAction[];
  approvalNeeds: AoiActionLadderApprovalNeed[];
  preparedWorkOrder?: AoiBoundedWorkOrder;
  evidenceNeeds: string[];
  safeFallback: string;
  connectionLabels: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

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
  | 'wrong_source'
  | 'stale'
  | 'too_frequent'
  | 'too_much'
  | 'wrong_timing'
  | 'unsafe'
  | 'already_done'
  | 'needs_more_detail';

export type AoiInterestTopicSource =
  | 'memory'
  | 'manual'
  | 'feedback'
  | 'research_run'
  | 'project_context';

export interface AoiInterestTopic {
  version: 1;
  id: string;
  sessionPath: string;
  label: string;
  normalizedLabel: string;
  aliases: string[];
  source: AoiInterestTopicSource;
  memoryIds: string[];
  evidenceRefs: string[];
  confidence: number;
  importance: number;
  noveltyPreference: number;
  currentInfoPreference: number;
  muted: boolean;
  pinned: boolean;
  cooldownKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface AoiInterestProfile {
  version: 1;
  sessionPath: string;
  topics: AoiInterestTopic[];
  generatedAt: number;
  sourceMemoryCount: number;
  warnings: string[];
}

export type AoiProactiveTrendWatchCadence = 'manual' | 'daily' | 'weekly';

export interface AoiProactiveTrendWatchTopic {
  version: 1;
  id: string;
  topicId: string;
  topicLabel: string;
  normalizedLabel: string;
  aliases: string[];
  watchQueries: string[];
  preferredSourceHosts: string[];
  cadence: AoiProactiveTrendWatchCadence;
  noveltyThreshold: number;
  directChatSensitivity: number;
  muted: boolean;
  pinned: boolean;
  confidence: number;
  evidenceRefs: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AoiProactiveTrendWatchProfile {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  sourceTopicCount: number;
  topicWatches: AoiProactiveTrendWatchTopic[];
  evidenceRefs: string[];
}

export type AoiProactiveTrendSnapshotFreshness = 'fresh' | 'unknown' | 'stale';

export type AoiProactiveTrendNoveltyStatus = 'new' | 'repeat' | 'weak' | 'stale';

export interface AoiProactiveTrendNovelty {
  version: 1;
  status: AoiProactiveTrendNoveltyStatus;
  score: number;
  reason: string;
  matchedSnapshotIds: string[];
  sourceOverlapCount: number;
}

export type AoiProactiveTrendDeliveryMode =
  | 'dashboard'
  | 'quiet_notification'
  | 'inline_card'
  | 'direct_chat'
  | 'blocked';

export type AoiProactiveTrendSourceQualityStatus = 'strong' | 'acceptable' | 'weak' | 'blocked';

export interface AoiProactiveTrendSourceQuality {
  version: 1;
  status: AoiProactiveTrendSourceQualityStatus;
  score: number;
  independentHostCount: number;
  freshSourceCount: number;
  publicSourceCount: number;
  evidenceRefCount: number;
  reasons: string[];
  blockedReasons: string[];
}

export type AoiProactiveTrendInterestDriftStatus = 'aligned' | 'watch' | 'drifting' | 'muted';

export interface AoiProactiveTrendInterestDrift {
  version: 1;
  status: AoiProactiveTrendInterestDriftStatus;
  score: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
  reasons: string[];
  evidenceRefs: string[];
}

export interface AoiProactiveTrendDeliveryControls {
  version: 1;
  dedupeKey: string;
  duplicateBlocked: boolean;
  quietUntil?: number;
  snoozedUntil?: number;
  reasons: string[];
  evidenceRefs: string[];
}

export interface AoiProactiveTrendSnapshot {
  version: 1;
  id: string;
  sessionPath: string;
  topicId: string;
  topicLabel: string;
  candidateId?: string;
  title: string;
  whatChanged: string;
  whyItMatters: string;
  myTake: string;
  suggestedNextAction: string;
  confidence: number;
  noveltyScore: number;
  novelty: AoiProactiveTrendNovelty;
  risk: AoiAutonomyRisk;
  freshness: AoiProactiveTrendSnapshotFreshness;
  sourceQuality: AoiProactiveTrendSourceQuality;
  interestDrift: AoiProactiveTrendInterestDrift;
  sources: AoiProactiveBriefSource[];
  delivery: {
    mode: AoiProactiveTrendDeliveryMode;
    summary: string;
    directChatAllowed: boolean;
    directChatBlockedReasons: string[];
    controls: AoiProactiveTrendDeliveryControls;
    chatHookText?: string;
    evidenceRefs: string[];
  };
  evidenceRefs: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface AoiProactiveTrendSnapshotIndexEntry {
  id: string;
  topicId: string;
  topicLabel: string;
  title: string;
  candidateId?: string;
  freshness: AoiProactiveTrendSnapshotFreshness;
  confidence: number;
  noveltyStatus: AoiProactiveTrendNoveltyStatus;
  deliveryMode: AoiProactiveTrendDeliveryMode;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface AoiProactiveTrendSnapshotIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiProactiveTrendSnapshotIndexEntry[];
}

export type AoiProactiveTrendDeliveryEventKind =
  | 'inline_card_shown'
  | 'direct_chat_offered'
  | 'delivery_suppressed';

export interface AoiProactiveTrendDeliveryEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiProactiveTrendDeliveryEventKind;
  snapshotId: string;
  candidateId?: string;
  topicId: string;
  topicLabel: string;
  deliveryMode: AoiProactiveTrendDeliveryMode;
  dedupeKey: string;
  title: string;
  sourceQualityStatus: AoiProactiveTrendSourceQualityStatus;
  interestDriftStatus: AoiProactiveTrendInterestDriftStatus;
  suppressionReasons: string[];
  sourceHosts: string[];
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiProactiveTrendDeliveryEventIndexEntry {
  id: string;
  kind: AoiProactiveTrendDeliveryEventKind;
  snapshotId: string;
  candidateId?: string;
  topicId: string;
  deliveryMode: AoiProactiveTrendDeliveryMode;
  dedupeKey: string;
  createdAt: number;
}

export interface AoiProactiveTrendDeliveryEventIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiProactiveTrendDeliveryEventIndexEntry[];
}

export interface AoiProactiveTrendDeliveryAuditSummary {
  version: 1;
  inlineShownCount: number;
  directChatOfferedCount: number;
  suppressedCount: number;
  latestEventAt?: number;
  evidenceRefs: string[];
}

export type AoiProactiveTrendAdvisorReadinessStatus =
  | 'not_configured'
  | 'measuring'
  | 'ready'
  | 'blocked';

export interface AoiProactiveTrendAdvisorReadiness {
  version: 1;
  status: AoiProactiveTrendAdvisorReadinessStatus;
  sampleCount: number;
  directChatReady: boolean;
  directChatBlockedReasons: string[];
  summary: string;
  evidenceRefs: string[];
}

export interface AoiProactiveTrendOpinionCard {
  version: 1;
  id: string;
  snapshotId: string;
  candidateId?: string;
  topicId: string;
  topicLabel: string;
  title: string;
  whatChanged: string;
  whyItMatters: string;
  myTake: string;
  suggestedNextAction: string;
  confidenceLabel: string;
  freshnessLabel: string;
  noveltyLabel: string;
  sourceQualityLabel: string;
  interestDriftLabel: string;
  deliveryMode: AoiProactiveTrendDeliveryMode;
  deliverySummary: string;
  controlSummary: string;
  sourceHosts: string[];
  sources: AoiProactiveBriefSource[];
  followUpPrompts: string[];
  directChatAllowed: boolean;
  directChatBlockedReasons: string[];
  quietUntil?: number;
  snoozedUntil?: number;
  chatHookText?: string;
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiProactiveTrendAdvisorState {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  watchProfile: AoiProactiveTrendWatchProfile;
  snapshots: AoiProactiveTrendSnapshot[];
  opinionCards: AoiProactiveTrendOpinionCard[];
  quietNotificationCount: number;
  directChatHookCount: number;
  sourceQualityCounts: Partial<Record<AoiProactiveTrendSourceQualityStatus, number>>;
  interestDriftCounts: Partial<Record<AoiProactiveTrendInterestDriftStatus, number>>;
  deliveryControlBlockedReasons: string[];
  recentDeliveryEvents: AoiProactiveTrendDeliveryEvent[];
  deliveryAuditSummary: AoiProactiveTrendDeliveryAuditSummary;
  inlineCard?: AoiProactiveTrendOpinionCard;
  directChatCard?: AoiProactiveTrendOpinionCard;
  chatHook?: string;
  readiness: AoiProactiveTrendAdvisorReadiness;
  evidenceRefs: string[];
}

export type AoiProactiveBriefStatus =
  | 'candidate'
  | 'shown'
  | 'accepted'
  | 'dismissed'
  | 'archived'
  | 'expired'
  | 'blocked';

export type AoiProactiveBriefDeliveryMode = 'dashboard' | 'digest' | 'inline_card' | 'chat_hook';

export interface AoiProactiveBriefSource {
  title: string;
  url: string;
  host: string;
  publishedAt?: string;
  retrievedAt: number;
  snippet: string;
}

export interface AoiProactiveBriefCandidate {
  version: 1;
  id: string;
  sessionPath: string;
  topicId: string;
  topicLabel: string;
  status: AoiProactiveBriefStatus;
  title: string;
  hook: string;
  summary: string;
  whyForOperator: string;
  noveltyReason: string;
  sources: AoiProactiveBriefSource[];
  evidenceRefs: string[];
  memoryIds: string[];
  researchRunId?: string;
  score: number;
  confidence: number;
  risk: AoiAutonomyRisk;
  freshness: {
    searchedAt: number;
    newestSourceAt?: string;
    cannotKnow: string[];
  };
  delivery: {
    allowedModes: AoiProactiveBriefDeliveryMode[];
    selectedMode?: AoiProactiveBriefDeliveryMode;
    quietModeSuppressed?: boolean;
    lastShownAt?: number;
  };
  cooldownKey: string;
  dedupeKey?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type AoiProactiveBriefFeedbackCategory =
  | 'useful'
  | 'not_useful'
  | 'show_more'
  | 'show_less'
  | 'wrong_topic'
  | 'wrong_source'
  | 'wrong_timing'
  | 'too_frequent'
  | 'stale'
  | 'unsafe'
  | 'mute_topic'
  | 'pin_topic'
  | 'archive_brief'
  | 'open_sources'
  | 'expand_summary';

export interface AoiProactiveBriefFeedback {
  version: 1;
  id: string;
  briefId: string;
  topicId: string;
  sessionPath: string;
  category: AoiProactiveBriefFeedbackCategory;
  note?: string;
  createdAt: number;
}

export interface AoiProactiveBriefCooldownEntry {
  version: 1;
  cooldownKey: string;
  topicId?: string;
  nextAllowedAt: number;
  reason: string;
  sourceBriefIds: string[];
  updatedAt: number;
}

export interface AoiProactiveBriefCooldownState {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  cooldowns: Record<string, AoiProactiveBriefCooldownEntry>;
}

export interface AoiProactiveBriefIndexEntry {
  id: string;
  topicId: string;
  cooldownKey: string;
  status: AoiProactiveBriefStatus;
  title: string;
  dedupeKey: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface AoiProactiveBriefIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiProactiveBriefIndexEntry[];
}

export type AoiProactiveBriefFieldEventKind =
  | 'candidate_created'
  | 'shown_dashboard'
  | 'shown_digest'
  | 'shown_inline'
  | 'chat_hook_offered'
  | 'expanded'
  | 'source_opened'
  | 'feedback_recorded'
  | 'suppressed_quiet_mode'
  | 'suppressed_cooldown'
  | 'suppressed_stale_source'
  | 'suppressed_no_opt_in'
  | 'suppressed_budget'
  | 'suppressed_no_topics'
  | 'expired'
  | 'archived';

export interface AoiProactiveBriefFieldEventFreshness {
  searchedAt?: number;
  newestSourceAt?: string;
  cannotKnow: string[];
  stale: boolean;
}

export interface AoiProactiveBriefFieldEventPrivacy {
  redacted: boolean;
  privateLeakDetected: boolean;
  unauthorizedMutationDetected: boolean;
  redactionReasons: string[];
}

export interface AoiProactiveBriefFieldEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiProactiveBriefFieldEventKind;
  briefId?: string;
  topicId?: string;
  feedbackId?: string;
  feedbackCategory?: AoiProactiveBriefFeedbackCategory;
  deliveryMode?: AoiProactiveBriefDeliveryMode;
  policyReason?: string;
  suppressionReasons: string[];
  title?: string;
  summary?: string;
  sourceRefs: string[];
  sourceHosts: string[];
  evidenceRefs: string[];
  freshness: AoiProactiveBriefFieldEventFreshness;
  privacy: AoiProactiveBriefFieldEventPrivacy;
  dedupeKey?: string;
  createdAt: number;
}

export interface AoiProactiveBriefFieldEventIndexEntry {
  id: string;
  kind: AoiProactiveBriefFieldEventKind;
  createdAt: number;
  briefId?: string;
  topicId?: string;
  feedbackId?: string;
  deliveryMode?: AoiProactiveBriefDeliveryMode;
  dedupeKey?: string;
}

export interface AoiProactiveBriefFieldEventIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiProactiveBriefFieldEventIndexEntry[];
}

export interface AoiProactiveBriefFieldMetrics {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  status: 'not_field_tested' | 'field_events_recorded' | 'blocked';
  eventCount: number;
  consideredCount: number;
  shownCount: number;
  shownByDeliveryMode: Record<AoiProactiveBriefDeliveryMode, number>;
  expandedCount: number;
  sourceOpenedCount: number;
  feedbackRecordedCount: number;
  usefulCount: number;
  tooFrequentCount: number;
  wrongTopicCount: number;
  wrongTimingCount: number;
  staleCount: number;
  staleCurrentClaimCount: number;
  unsafeCount: number;
  suppressionCounts: Record<string, number>;
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  directChatHookCount: number;
  lastEventAt?: number;
  evidenceRefs: string[];
}

export type AoiProactiveBriefCalibrationLabel =
  | 'useful'
  | 'show_more'
  | 'show_less'
  | 'too_frequent'
  | 'wrong_topic'
  | 'wrong_source'
  | 'wrong_timing'
  | 'stale'
  | 'unsafe'
  | 'mute_topic'
  | 'pin_topic';

export interface AoiProactiveBriefCalibrationLabelRecord {
  version: 1;
  id: string;
  sessionPath: string;
  fieldEventId: string;
  briefId?: string;
  topicId?: string;
  label: AoiProactiveBriefCalibrationLabel;
  actor: 'user' | 'system';
  note?: string;
  deliveryMode?: AoiProactiveBriefDeliveryMode;
  policyReason?: string;
  sourceRefs: string[];
  sourceHosts: string[];
  evidenceRefs: string[];
  createdAt: number;
}

export interface AoiProactiveBriefCalibrationLabelIndexEntry {
  id: string;
  fieldEventId: string;
  label: AoiProactiveBriefCalibrationLabel;
  createdAt: number;
  briefId?: string;
  topicId?: string;
}

export interface AoiProactiveBriefCalibrationLabelIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  entries: AoiProactiveBriefCalibrationLabelIndexEntry[];
}

export interface AoiProactiveBriefCalibrationInboxItem {
  version: 1;
  id: string;
  sessionPath: string;
  fieldEventId: string;
  fieldEventKind: AoiProactiveBriefFieldEventKind;
  fieldEventAt: number;
  briefId?: string;
  topicId?: string;
  deliveryMode?: AoiProactiveBriefDeliveryMode;
  title: string;
  whyNow: string;
  whyRelevant: string;
  sourceFreshness: string;
  cannotKnowLabels: string[];
  sourceRefs: string[];
  sourceHosts: string[];
  policyReason?: string;
  labels: AoiProactiveBriefCalibrationLabelRecord[];
  labelState: 'unlabeled' | 'labeled' | 'unsafe_flagged';
  latestLabel?: AoiProactiveBriefCalibrationLabel;
  latestLabelAt?: number;
  suggestedLabels: AoiProactiveBriefCalibrationLabel[];
  priorityScore: number;
  evidenceRefs: string[];
}

export interface AoiProactiveBriefCalibrationInbox {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  inboxCount: number;
  unlabeledCount: number;
  labeledCount: number;
  labelCount: number;
  unsafeLabelCount: number;
  staleLabelCount: number;
  items: AoiProactiveBriefCalibrationInboxItem[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefTopicCalibrationTuning {
  version: 1;
  topicId: string;
  labelCounts: Partial<Record<AoiProactiveBriefCalibrationLabel, number>>;
  scoreDelta: number;
  confidenceDelta: number;
  sourcePreferenceDelta: number;
  chatHookThresholdDelta: number;
  cooldownMs: number;
  directChatBlocked: boolean;
  preferDigestOrDashboard: boolean;
  muted: boolean;
  pinned: boolean;
  conservativeReasons: string[];
  evidenceRefs: string[];
  updatedAt: number;
}

export interface AoiProactiveBriefSourceCalibrationTuning {
  version: 1;
  host: string;
  labelCounts: Partial<Record<AoiProactiveBriefCalibrationLabel, number>>;
  preferenceDelta: number;
  directChatBlocked: boolean;
  staleBlocked: boolean;
  unsafeBlocked: boolean;
  evidenceRefs: string[];
  updatedAt: number;
}

export interface AoiProactiveBriefCalibrationTuning {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  status: 'no_labels' | 'tuning_active' | 'blocked';
  labelCount: number;
  labelDistribution: Record<AoiProactiveBriefCalibrationLabel, number>;
  unsafeLabelCount: number;
  staleLabelCount: number;
  tooFrequentLabelCount: number;
  wrongTimingLabelCount: number;
  mutedTopicCount: number;
  pinnedTopicCount: number;
  topicTuning: Record<string, AoiProactiveBriefTopicCalibrationTuning>;
  sourceTuning: Record<string, AoiProactiveBriefSourceCalibrationTuning>;
  summaryLabels: string[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefQuietWindow {
  version: 1;
  enabled: boolean;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
}

export interface AoiProactiveBriefTopicControl {
  version: 1;
  topicId: string;
  allowed: boolean;
  muted: boolean;
  pinned: boolean;
  updatedAt: number;
}

export interface AoiProactiveBriefSourceHostControl {
  version: 1;
  host: string;
  allowed: boolean;
  muted: boolean;
  updatedAt: number;
}

export interface AoiProactiveBriefSchedulerControls {
  version: 1;
  enabled: boolean;
  allowBackgroundScout: boolean;
  maxScoutRunsPerDay: number;
  maxScoutRunsPerSession: number;
  maxTopicsPerWakeup: number;
  maxNetworkCallsPerWakeup: number;
  minScoutCooldownMs: number;
  maxSessionIdleMs: number;
  quietWindow: AoiProactiveBriefQuietWindow;
  directChatHookOptIn: boolean;
  topicControls: Record<string, AoiProactiveBriefTopicControl>;
  sourceHostControls: Record<string, AoiProactiveBriefSourceHostControl>;
}

export interface AoiProactiveBriefScoutBudgetState {
  version: 1;
  dayKey: string;
  runsToday: number;
  runsThisSession: number;
  updatedAt: number;
}

export type AoiProactiveBriefSchedulerRunStatus =
  | 'not_requested'
  | 'blocked'
  | 'scouted'
  | 'no_candidate'
  | 'failed';

export interface AoiProactiveBriefSchedulerRunRecord {
  version: 1;
  requested: boolean;
  runNow: boolean;
  background: boolean;
  status: AoiProactiveBriefSchedulerRunStatus;
  provider: 'tavily' | 'test' | 'none';
  providerConfigured: boolean;
  startedAt: number;
  completedAt: number;
  createdCandidateCount: number;
  skippedTopicCount: number;
  sourceFreshnessCount: number;
  trendSnapshotCount?: number;
  trendOpinionCardCount?: number;
  trendDirectChatReadyCount?: number;
  trendDeliveryModes?: Partial<Record<AoiProactiveTrendDeliveryMode, number>>;
  trendBlockedReasons?: string[];
  topicIds: string[];
  blockedReasons: string[];
  warnings: string[];
  budget: {
    dayKey: string;
    runsToday: number;
    maxRunsPerDay: number;
    runsThisSession: number;
    maxRunsPerSession: number;
  };
  controlSnapshot?: {
    version: 1;
    enabled: boolean;
    allowBackgroundScout: boolean;
    directChatHookOptIn: boolean;
    quietWindowEnabled: boolean;
    quietWindowActive: boolean;
    maxScoutRunsPerDay: number;
    maxScoutRunsPerSession: number;
    maxTopicsPerWakeup: number;
    maxNetworkCallsPerWakeup: number;
    minScoutCooldownMs: number;
    maxSessionIdleMs: number;
    topicControlCount: number;
    allowedTopicCount: number;
    mutedTopicCount: number;
    sourceHostControlCount: number;
    allowedSourceHostCount: number;
    mutedSourceHostCount: number;
    actionAuthority: 'display_only';
    mutationCount: 0;
  };
  evidenceRefs: string[];
}

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
  | 'health_check'
  | 'scheduled_background';

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
  | 'blocked_item'
  | 'operator_health'
  | 'proactive_interest_brief';

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

export type AoiOperatorVoiceEventCategory =
  | 'session_resume'
  | 'critical_blocker'
  | 'approval_required'
  | 'completion_update'
  | 'health_degraded'
  | 'fyi';

export type AoiVoiceInterruptionLevel = 'silent' | 'ambient' | 'mission' | 'blocking';

export type AoiVoicePersonalMetadataScope = 'redacted' | 'metadata';

export interface AoiVoiceQuietWindow {
  version: 1;
  enabled: boolean;
  reason: string;
  startedAt?: number;
  endsAt?: number;
  categories?: AoiOperatorVoiceEventCategory[];
}

export interface AoiOperatorVoicePolicy {
  version: 1;
  enabled: boolean;
  allowedCategories: Record<AoiOperatorVoiceEventCategory, boolean>;
  quietWindows: AoiVoiceQuietWindow[];
  personalMetadataVoiceScope: AoiVoicePersonalMetadataScope;
  minInterruptionLevel: AoiVoiceInterruptionLevel;
}

export type AoiOperatorHealthSeverity = 'info' | 'warning' | 'error' | 'blocker';

export type AoiOperatorHealthStatus = 'healthy' | 'limited' | 'degraded' | 'blocked';

export type AoiOperatorHealthCapability =
  | 'memory'
  | 'research'
  | 'kira'
  | 'workspace'
  | 'personal_signals'
  | 'voice'
  | 'approved_commands'
  | 'replay_evaluation';

export type AoiOperatorHealthRecommendationAction =
  | 'open_source_settings'
  | 'configure_tavily'
  | 'connect_gmail'
  | 'open_kira_settings'
  | 'refresh_workspace'
  | 'run_validation'
  | 'review_scheduler'
  | 'review_replay'
  | 'review_approved_command_policy'
  | 'enable_voice'
  | 'inspect_memory';

export interface AoiOperatorHealthRecommendation {
  version: 1;
  action: AoiOperatorHealthRecommendationAction;
  label: string;
  targetPanel?: string;
  targetRef?: string;
}

export interface AoiOperatorHealthIssue {
  version: 1;
  id: string;
  capability: AoiOperatorHealthCapability;
  severity: AoiOperatorHealthSeverity;
  code: string;
  title: string;
  summary: string;
  cannotKnow?: string;
  sourceId?: string;
  observedAt: number;
  evidenceRefs: string[];
  recommendation: AoiOperatorHealthRecommendation;
}

export interface AoiOperatorHealthCapabilityState {
  version: 1;
  capability: AoiOperatorHealthCapability;
  status: AoiOperatorHealthStatus;
  highestSeverity: AoiOperatorHealthSeverity;
  issueCount: number;
  summary: string;
  issueIds: string[];
}

export interface AoiOperatorHealthState {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  overallStatus: AoiOperatorHealthStatus;
  summary: string;
  capabilities: AoiOperatorHealthCapabilityState[];
  issues: AoiOperatorHealthIssue[];
  userBlockingIssueCount: number;
  evidenceRefs: string[];
}

export interface AoiOperatorVoiceEvent {
  version: 1;
  id: string;
  sessionPath: string;
  category: AoiOperatorVoiceEventCategory;
  interruptionLevel: AoiVoiceInterruptionLevel;
  title: string;
  whatChanged: string;
  nextSafeAction: string;
  approvalBoundary?: string;
  risk: AoiAutonomyRisk;
  dedupeKey: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  createdAt: number;
  privateContent?: boolean;
}

export type AoiVoiceRenderDecisionStatus =
  | 'spoken'
  | 'suppressed'
  | 'muted'
  | 'quiet_window'
  | 'duplicate'
  | 'disabled_category'
  | 'tts_disabled'
  | 'not_mission_relevant'
  | 'no_event'
  | 'playback_failed';

export interface AoiVoiceRenderDecision {
  version: 1;
  id: string;
  sessionPath: string;
  createdAt: number;
  status: AoiVoiceRenderDecisionStatus;
  shouldSpeak: boolean;
  silentReason: string;
  reasons: string[];
  replayable: boolean;
  evidenceRefs: string[];
  eventId?: string;
  eventDedupeKey?: string;
  category?: AoiOperatorVoiceEventCategory;
  spokenSummary?: string;
  summaryId?: string;
  transcriptHash?: string;
}

export type AoiCalibrationDimension =
  | 'source_kind'
  | 'trigger_kind'
  | 'action_kind'
  | 'risk_level'
  | 'notification_lane'
  | 'voice_category'
  | 'interruption_gap'
  | 'feedback_category';

export type AoiCalibrationDirection = 'positive' | 'negative' | 'safety';

export interface AoiCalibrationEvidence {
  version: 1;
  id: string;
  dimension: AoiCalibrationDimension;
  key: string;
  direction: AoiCalibrationDirection;
  delta: number;
  reason: string;
  createdAt: number;
  evidenceRefs: string[];
  feedbackCategory?: AoiProposalFeedbackCategory;
  replayBlocked?: boolean;
}

export interface AoiTriggerCalibration {
  version: 1;
  triggerKind: string;
  usefulnessScore: number;
  interruptionScore: number;
  requiredEvidenceBoost: number;
  approvalStrictnessBoost: number;
  evidenceCount: number;
  lastUpdatedAt?: number;
  evidenceRefs: string[];
}

export interface AoiSourceCalibration {
  version: 1;
  sourceKind: string;
  usefulnessScore: number;
  selectionPenalty: number;
  evidenceCount: number;
  negativeFeedbackCount: number;
  lastUpdatedAt?: number;
  evidenceRefs: string[];
}

export interface AoiActionCalibration {
  version: 1;
  actionKind: string;
  usefulnessScore: number;
  approvalStrictnessBoost: number;
  evidenceCount: number;
  unsafeFeedbackCount: number;
  lastUpdatedAt?: number;
  evidenceRefs: string[];
}

export interface AoiInterruptionPolicy {
  version: 1;
  defaultThreshold: number;
  askFirstThreshold: number;
  suppressThreshold: number;
  minInterruptionGapMs: number;
  positiveLearningCap: number;
  negativeLearningCap: number;
}

export interface AoiTrustCalibrationReset {
  version: 1;
  dimension: AoiCalibrationDimension;
  key: string;
  resetAt: number;
}

export interface AoiTrustCalibrationProfile {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  interruptionPolicy: AoiInterruptionPolicy;
  triggerCalibrations: AoiTriggerCalibration[];
  sourceCalibrations: AoiSourceCalibration[];
  actionCalibrations: AoiActionCalibration[];
  riskCalibration: Record<AoiAutonomyRisk, number>;
  laneCalibration: Partial<Record<AoiNotificationLane, number>>;
  voiceCalibration: Partial<Record<AoiOperatorVoiceEventCategory, number>>;
  feedbackCalibration: Partial<Record<AoiProposalFeedbackCategory, number>>;
  topSuppressedCategories: AoiCalibrationEvidence[];
  negativeSources: AoiSourceCalibration[];
  recentChanges: AoiCalibrationEvidence[];
  resetCategories: AoiTrustCalibrationReset[];
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
  | 'outcome_signal_recorded'
  | 'operator_voice_decision'
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
  proactiveScout?: AoiProactiveBriefSchedulerRunRecord;
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
  proactiveScoutBudget?: AoiProactiveBriefScoutBudgetState;
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
  | 'file_write'
  | 'file_patch'
  | 'file_delete'
  | 'app_action'
  | 'connector_call'
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
  approvalSandbox?: AoiApprovalSandboxPreview;
  approvalSandboxValidation?: AoiApprovalSandboxValidationResult;
  blockers: string[];
  nonGoals: string[];
}

export type AoiPlaybookStatus =
  | 'preview'
  | 'active'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'archived';

export type AoiPlaybookStepKind =
  | 'inspect_context'
  | 'read_research_artifact'
  | 'start_research'
  | 'create_kira_work'
  | 'preview_command'
  | 'run_approved_command'
  | 'summarize_result'
  | 'ask_user'
  | 'wait_for_external_event';

export type AoiPlaybookStepStatus =
  | 'pending'
  | 'ready'
  | 'waiting_for_approval'
  | 'waiting_for_external_event'
  | 'completed'
  | 'blocked'
  | 'skipped';

export type AoiPlaybookEvidenceKind =
  | 'inspect_context_completed'
  | 'read_research_artifact_completed'
  | 'research_completed'
  | 'kira_work_created'
  | 'kira_work_completed'
  | 'approved_command_recorded'
  | 'summarize_result_completed'
  | 'user_decision_recorded'
  | 'step_failed';

export interface AoiPlaybookExecutionBoundary {
  version: 1;
  mutationCapable: boolean;
  commandCapable: boolean;
  requiresApproval: boolean;
  requiredAutonomyLevel: AoiAutonomyLevel;
  freshAcceptanceRequired: boolean;
  approver: 'user' | 'kira_reviewer' | 'none';
  existingGate:
    | 'none'
    | 'proposal_acceptance'
    | 'research_approval'
    | 'kira_handoff'
    | 'approved_command'
    | 'user_decision';
  canAutoRun: false;
  summary: string;
  approvalRef?: string;
}

export interface AoiPlaybookStepRefs {
  proposalRef?: string;
  goalRef?: string;
  missionRef?: string;
  researchRunRef?: string;
  researchArtifactRef?: string;
  kiraWorkRef?: string;
  commandAuditRef?: string;
  timelineEventRef?: string;
}

export interface AoiPlaybookStep {
  version: 1;
  id: string;
  kind: AoiPlaybookStepKind;
  title: string;
  summary: string;
  status: AoiPlaybookStepStatus;
  dependsOn: string[];
  evidenceRefs: string[];
  sourceRefs: string[];
  resultSummary?: string;
  blockedReasons: string[];
  executionBoundary: AoiPlaybookExecutionBoundary;
  checkpointNotes: string[];
  rollbackNotes: string[];
  validationNotes: string[];
  refs: AoiPlaybookStepRefs;
  updatedAt: number;
}

export interface AoiPlaybookEdge {
  version: 1;
  id: string;
  fromStepId: string;
  toStepId: string;
  kind: 'depends_on' | 'unblocks' | 'waits_for';
  evidenceRefs: string[];
}

export interface AoiPlaybook {
  version: 1;
  id: string;
  sessionPath: string;
  title: string;
  objective: string;
  status: AoiPlaybookStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  sourceRefs: string[];
  evidenceRefs: string[];
  goalId?: string;
  proposalId?: string;
  missionRef?: string;
  healthIssueRefs: string[];
  blockedReasons: string[];
  nextStepId?: string;
  nextRequiredDecision: string;
  steps: AoiPlaybookStep[];
  edges: AoiPlaybookEdge[];
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
  | 'approval_env_changed'
  | 'approval_preview_changed'
  | 'approval_target_changed'
  | 'approval_authority_decision_changed'
  | 'approval_rollback_plan_changed'
  | 'approval_recovery_plan_changed'
  | 'approval_validation_changed'
  | 'approval_fingerprint_changed'
  | 'approval_sandbox_missing'
  | 'rollback_recovery_evidence_missing'
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
  approvalSandbox?: AoiApprovalSandboxPreview;
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
  approvalSandboxPreviewHash?: string;
  approvalSandboxValidationStatus?: AoiApprovalSandboxValidationResult['state'];
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

// Approved file-mutation capability (file_write / file_patch). Mirrors the
// approved-command subsystem: a content-addressed approval fingerprint is
// computed from the operation, normalized path, and content/patch bytes, stored
// on the accept decision, and re-validated at execution time. Every mutation is
// guarded by a pre-change checkpoint (see aoiActionCheckpoint.ts).
export type AoiFileMutationOperation = 'write' | 'patch' | 'delete';

export interface AoiFileMutationPatchOp {
  find: string;
  replace: string;
  // Exact number of non-overlapping occurrences of `find` expected in the file.
  // Defaults to 1 so a patch anchors unambiguously; a mismatch aborts the apply.
  expectedCount?: number;
}

export type AoiFileMutationBlockReason =
  | 'missing_path'
  | 'path_not_relative'
  | 'path_escapes_workspace'
  | 'unsafe_path'
  | 'protected_path'
  | 'missing_content'
  | 'content_too_large'
  | 'missing_patch_ops'
  | 'too_many_patch_ops'
  | 'invalid_patch_op'
  | 'patch_op_too_large'
  | 'unsupported_operation'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_path_changed'
  | 'approval_operation_changed'
  | 'approval_content_changed'
  | 'approval_risk_changed'
  | 'approval_purpose_changed'
  | 'approval_preview_changed'
  | 'approval_target_changed'
  | 'approval_authority_decision_changed'
  | 'approval_rollback_plan_changed'
  | 'approval_recovery_plan_changed'
  | 'approval_validation_changed'
  | 'approval_fingerprint_changed'
  | 'approval_sandbox_missing'
  | 'rollback_recovery_evidence_missing'
  | 'workspace_root_missing'
  | 'checkpoint_failed'
  | 'patch_target_missing'
  | 'patch_anchor_mismatch'
  | 'delete_target_missing'
  | 'execution_failed'
  | 'verification_failed';

export interface AoiApprovedFileMutationRequest {
  version: 1;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  operation: AoiFileMutationOperation;
  path: string;
  content?: string;
  patchOps?: AoiFileMutationPatchOp[];
  purpose: string;
  risk: AoiAutonomyRisk;
  requestedAt: number;
  evidenceRefs: string[];
}

export interface AoiApprovedFileMutationPolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiFileMutationBlockReason[];
  operation: AoiFileMutationOperation;
  path: string;
  pathLabel: string;
  pathHash: string;
  // sha256 of the post-change content (write) or of the normalized patch ops
  // (patch). Binds the approval to exact bytes.
  contentHash: string;
  byteLength: number;
  patchOps?: AoiFileMutationPatchOp[];
  purpose: string;
  purposeHash: string;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox?: AoiApprovalSandboxPreview;
  expiresAt: number;
  rationale: string[];
}

export interface AoiFileMutationAuditRecord {
  version: 1;
  id: string;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  operation: AoiFileMutationOperation;
  pathLabel: string;
  pathHash: string;
  purpose: string;
  risk: AoiAutonomyRisk;
  allowed: boolean;
  blockReasons: AoiFileMutationBlockReason[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  applied: boolean;
  rolledBack: boolean;
  bytesBefore: number | null;
  bytesAfter: number | null;
  contentHash: string;
  checkpointId?: string;
  evidenceRefs: string[];
  approvalFingerprint: string;
  approvalSandboxPreviewHash?: string;
  approvalSandboxValidationStatus?: AoiApprovalSandboxValidationResult['state'];
}

export interface AoiApprovedFileMutationResult {
  version: 1;
  ok: boolean;
  operation: AoiFileMutationOperation;
  pathLabel: string;
  applied: boolean;
  rolledBack: boolean;
  bytesBefore: number | null;
  bytesAfter: number | null;
  checkpointId?: string;
  checkpoint?: AoiActionCheckpoint;
  blockReasons: AoiFileMutationBlockReason[];
  auditRecord: AoiFileMutationAuditRecord;
  evidenceRefs: string[];
}

// ============ Approved Aoi App Action (capability-broker execute band) ============
//
// The app_action proposal capability flows through the capability broker
// (decideAoiCapabilityBrokerAuthority), which classifies an executionKind. The
// runner branches on that classification:
//  - file_backed (schema_file_write / schema_file_delete / state_file_write):
//    a real, reversible mutation of an app dataRoot file, executed by reusing the
//    file-mutation checkpoint + runner.
//  - app_operation (app_action / window_action): a live app operation the server
//    cannot dispatch and cannot file-checkpoint; recovery is the app's own undo
//    via a Kira-style review handoff (wired in a follow-up commit).
export type AoiAppActionRouting = 'file_backed' | 'app_operation';

export type AoiAppActionBlockReason =
  | 'missing_app_reference'
  | 'missing_capability_reference'
  | 'unknown_app_or_capability'
  | 'unsupported_execution_kind'
  | 'broker_execution_blocked'
  | 'app_action_review_handoff_required'
  | 'missing_data_root'
  | 'path_outside_data_root'
  | 'file_mutation_blocked'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_app_changed'
  | 'approval_capability_changed'
  | 'approval_execution_kind_changed'
  | 'approval_operation_changed'
  | 'approval_risk_changed'
  | 'approval_purpose_changed'
  | 'approval_preview_changed'
  | 'approval_target_changed'
  | 'approval_authority_decision_changed'
  | 'approval_rollback_plan_changed'
  | 'approval_recovery_plan_changed'
  | 'approval_validation_changed'
  | 'approval_fingerprint_changed'
  | 'approval_sandbox_missing'
  | 'rollback_recovery_evidence_missing'
  | 'execution_failed';

export interface AoiApprovedAppActionRequest {
  version: 1;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  // App name (preferred) or numeric appId stringified.
  appReference: string;
  // One or more capability references; the broker matches by id/intent/action.
  capabilityId?: string;
  intentReference?: string;
  actionType?: string;
  requestedOperation?: string;
  // Pure app-operation params (Branch B). Filesystem-shaped fields below drive
  // the file_backed branch.
  operationParams?: Record<string, string>;
  path?: string;
  content?: string;
  patchOps?: AoiFileMutationPatchOp[];
  purpose: string;
  risk: AoiAutonomyRisk;
  requestedAt: number;
  evidenceRefs: string[];
}

export interface AoiApprovedAppActionPolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiAppActionBlockReason[];
  appId: number | null;
  appName: string;
  capabilityId: string;
  executionKind: AppIntentExecutionKind | 'unknown';
  routing: AoiAppActionRouting;
  mutationCapable: boolean;
  dataRoot?: string;
  // file_backed routing only: the embedded approved file-mutation policy the
  // runner applies behind a pre-change checkpoint.
  fileMutation?: AoiApprovedFileMutationPolicy;
  // Content-addressed hash of the app operation spec (app + capability +
  // executionKind + operation params or file content). Binds the approval.
  operationHash: string;
  purpose: string;
  purposeHash: string;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox?: AoiApprovalSandboxPreview;
  expiresAt: number;
  rationale: string[];
}

export interface AoiAppActionAuditRecord {
  version: 1;
  id: string;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  appName: string;
  capabilityId: string;
  executionKind: AppIntentExecutionKind | 'unknown';
  routing: AoiAppActionRouting;
  purpose: string;
  risk: AoiAutonomyRisk;
  allowed: boolean;
  blockReasons: AoiAppActionBlockReason[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  applied: boolean;
  rolledBack: boolean;
  reviewHandoff: boolean;
  operationHash: string;
  // file_backed routing: links to the underlying file-mutation audit/checkpoint.
  fileMutationAuditId?: string;
  pathLabel?: string;
  checkpointId?: string;
  // app_operation routing (Kira-style review handoff): the created work item ref.
  kiraWorkRef?: string;
  evidenceRefs: string[];
  approvalFingerprint: string;
  approvalSandboxPreviewHash?: string;
  approvalSandboxValidationStatus?: AoiApprovalSandboxValidationResult['state'];
}

export interface AoiApprovedAppActionResult {
  version: 1;
  ok: boolean;
  appName: string;
  capabilityId: string;
  executionKind: AppIntentExecutionKind | 'unknown';
  routing: AoiAppActionRouting;
  applied: boolean;
  rolledBack: boolean;
  reviewHandoff: boolean;
  // file_backed routing only:
  fileMutationResult?: AoiApprovedFileMutationResult;
  pathLabel?: string;
  checkpointId?: string;
  checkpoint?: AoiActionCheckpoint;
  blockReasons: AoiAppActionBlockReason[];
  auditRecord: AoiAppActionAuditRecord;
  evidenceRefs: string[];
}

// Connector-call (MCP RPC) types -- the connector analog of the app_action /
// file-mutation families. Unlike app_action's live op (browser-only postMessage),
// an HTTP MCP backend IS reachable from the Node server, so this is a real
// server-side live RPC. The endpoint is never proposal-controlled: the runner
// resolves a trusted connector by id from the server-readable allow-list
// (aoiMcpConnectorRegistry). External side effects are not reversible, so live
// execution is gated to read-only tools (and gated resources/read) this cut;
// side-effecting tools are recognized but blocked from live RPC for now.
export type AoiConnectorCallRouting = 'live_read_only' | 'side_effecting' | 'unknown';

export type AoiConnectorCallBlockReason =
  | 'missing_connector_reference'
  | 'missing_tool_name'
  | 'unknown_or_untrusted_connector'
  | 'endpoint_not_server_callable'
  | 'tool_not_allow_listed'
  | 'read_resource_not_allowed'
  | 'side_effecting_live_rpc_not_enabled'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_connector_changed'
  | 'approval_tool_changed'
  | 'approval_operation_changed'
  | 'approval_risk_changed'
  | 'approval_purpose_changed'
  | 'approval_preview_changed'
  | 'approval_target_changed'
  | 'approval_authority_decision_changed'
  | 'approval_rollback_plan_changed'
  | 'approval_recovery_plan_changed'
  | 'approval_validation_changed'
  | 'approval_fingerprint_changed'
  | 'approval_sandbox_missing'
  | 'execution_failed';

export interface AoiApprovedConnectorCallRequest {
  version: 1;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  // Connector id; the server resolves the endpoint from the trusted allow-list.
  connectorRef: string;
  // MCP tool name, or the 'resources/read' method sentinel.
  toolName: string;
  // For resources/read: the resource URI to read.
  resourceUri?: string;
  // Tool arguments. Canonicalized (sorted keys) for the content-addressed hash.
  args?: Record<string, unknown>;
  purpose: string;
  risk: AoiAutonomyRisk;
  requestedAt: number;
  evidenceRefs: string[];
}

export interface AoiApprovedConnectorCallPolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiConnectorCallBlockReason[];
  connectorRef: string;
  // Resolved trusted-connector id ('' when unresolved/untrusted).
  connectorId: string;
  connectorName: string;
  // Resolved endpoint hostname for audit/preview ('' when unresolved).
  endpointHost: string;
  toolName: string;
  routing: AoiConnectorCallRouting;
  readOnly: boolean;
  // Content-addressed hash of connector + tool + canonical args (+ resourceUri).
  operationHash: string;
  argsHash: string;
  purpose: string;
  purposeHash: string;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox?: AoiApprovalSandboxPreview;
  expiresAt: number;
  rationale: string[];
}

export interface AoiConnectorCallAuditRecord {
  version: 1;
  id: string;
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  connectorId: string;
  connectorName: string;
  endpointHost: string;
  toolName: string;
  routing: AoiConnectorCallRouting;
  readOnly: boolean;
  purpose: string;
  risk: AoiAutonomyRisk;
  allowed: boolean;
  blockReasons: AoiConnectorCallBlockReason[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  // True when the live RPC fired. External RPCs are not rolled back (best-effort).
  applied: boolean;
  // Bounded digest of the response for audit -- never the full payload.
  resultDigest?: string;
  operationHash: string;
  argsHash: string;
  evidenceRefs: string[];
  approvalFingerprint: string;
  approvalSandboxPreviewHash?: string;
  approvalSandboxValidationStatus?: AoiApprovalSandboxValidationResult['state'];
}

export interface AoiApprovedConnectorCallResult {
  version: 1;
  ok: boolean;
  connectorId: string;
  connectorName: string;
  endpointHost: string;
  toolName: string;
  routing: AoiConnectorCallRouting;
  readOnly: boolean;
  applied: boolean;
  // The unwrapped tool/resource result. The execution layer compacts it before
  // persisting; this carries the live value for the immediate caller.
  result?: unknown;
  resultDigest?: string;
  blockReasons: AoiConnectorCallBlockReason[];
  auditRecord: AoiConnectorCallAuditRecord;
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
  sourceFreshnessContractId?: string;
  cannotKnowStatements?: string[];
}

export interface AoiPersonalSignalMetadataSummary {
  version: 1;
  sourceId: string;
  kind: AoiPersonalSignalSourceKind;
  label: string;
  displayName: string;
  summary: string;
  relevanceText: string;
  evidenceRefs: string[];
  scoreReasons: string[];
  updatedAt: number;
  freshness: AoiSignalFreshness;
  confidence: number;
  redactionState: AoiContextRedactionState;
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
  approvedFileMutation?: AoiApprovedFileMutationPolicy;
  approvedAppAction?: AoiApprovedAppActionPolicy;
  approvedConnectorCall?: AoiApprovedConnectorCallPolicy;
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
  proactiveBriefing: AoiProactiveBriefSchedulerControls;
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
  activeOpportunityCount?: number;
  archivedOpportunityCount?: number;
  snoozedOpportunityCount?: number;
  expiredOpportunityCount?: number;
  lastOpportunityAt?: number;
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
  trustCalibrationProfile?: AoiTrustCalibrationProfile | null;
  // Server-readable trusted MCP connector allow-list, used to evaluate a
  // connector_call proposal's policy. Absent on client/preview paths (the
  // connector policy then fails closed); the server passes it from config.
  connectors?: AoiMcpConnectorsConfig | null;
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
  dedupeKey?: string;
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
  // Server-readable trusted MCP connector allow-list for a connector_call
  // proposal. The server passes it from config; absent on client/preview paths
  // (the connector policy then fails closed).
  connectors?: AoiMcpConnectorsConfig | null;
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
