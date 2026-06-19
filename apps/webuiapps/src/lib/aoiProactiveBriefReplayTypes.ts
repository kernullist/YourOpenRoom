import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiOperatorHealthCapability,
  AoiOperatorHealthSeverity,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCalibrationLabel,
  AoiProactiveBriefCalibrationLabelRecord,
  AoiProactiveBriefCalibrationTuning,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefFieldEvent,
  AoiProactiveBriefFieldMetrics,
  AoiProactiveBriefFeedback,
} from './aoiAutonomyTypes';
import type {
  AoiProactiveBriefDeliveryDecision,
  AoiProactiveBriefDeliverySuppressionReason,
} from './aoiProactiveBriefPolicy';
import type { AoiProactiveBriefSkippedTopic } from './aoiProactiveBriefPlanner';
import type {
  AoiProactiveBriefRawSearchResult,
  AoiProactiveBriefSourceFreshness,
} from './aoiProactiveBriefResearch';

export type AoiProactiveBriefReplayScenario =
  | 'fresh_public_sources'
  | 'tavily_missing'
  | 'quiet_mode'
  | 'too_frequent_feedback'
  | 'stale_sources'
  | 'private_memory_excluded'
  | 'useful_feedback_with_cooldown'
  | 'wrong_topic_feedback';

export type AoiProactiveBriefReplayMetricName =
  | 'candidate_precision'
  | 'source_freshness'
  | 'interruption_policy'
  | 'feedback_adaptation'
  | 'privacy_redaction'
  | 'no_fabricated_current_info';

export type AoiProactiveBriefDiagnosticCode =
  | 'tavily_unavailable'
  | 'source_freshness_stale'
  | 'no_eligible_topics'
  | 'all_topics_muted'
  | 'cooldown_suppressed_all_candidates'
  | 'direct_chat_disabled_by_policy'
  | 'field_not_tested'
  | 'field_private_leak_detected'
  | 'field_unauthorized_mutation_detected'
  | 'field_stale_current_claim_detected'
  | 'field_readiness_measuring'
  | 'field_readiness_ready'
  | 'field_direct_chat_not_ready'
  | 'field_replay_candidates_ready'
  | 'calibration_not_labeled'
  | 'calibration_tuning_active'
  | 'calibration_stale_direct_chat_block'
  | 'calibration_unsafe_label_blocker'
  | 'scout_provider_missing'
  | 'scout_provider_failed'
  | 'scout_network_disabled'
  | 'scout_budget_exhausted'
  | 'scout_no_eligible_topics'
  | 'scout_all_topics_muted'
  | 'scout_cooldown_active'
  | 'scout_quiet_window_active'
  | 'scout_direct_chat_disabled'
  | 'scout_unsafe_label_blocker'
  | 'scout_stale_source_blocker'
  | 'scout_no_candidate'
  | 'trend_watch_profile_empty'
  | 'trend_provider_missing'
  | 'trend_snapshot_stale'
  | 'trend_weak_evidence'
  | 'trend_source_quality_weak'
  | 'trend_repeat_snapshot'
  | 'trend_duplicate_suppressed'
  | 'trend_quiet_control_active'
  | 'trend_interest_drift_watch'
  | 'trend_interest_drift_detected'
  | 'trend_provider_smoke_ready'
  | 'trend_quiet_notification_ready'
  | 'trend_opinion_cards_ready'
  | 'trend_direct_chat_ready'
  | 'trend_direct_chat_not_ready';

export interface AoiProactiveBriefReplayMetric {
  name: AoiProactiveBriefReplayMetricName;
  passed: boolean;
  expected: string;
  actual: string;
  evidenceRefs: string[];
}

export interface AoiProactiveBriefDiagnostic {
  version: 1;
  code: AoiProactiveBriefDiagnosticCode;
  severity: AoiOperatorHealthSeverity;
  capability: AoiOperatorHealthCapability;
  summary: string;
  cannotKnow: string;
  evidenceRefs: string[];
  observedAt: number;
}

export interface AoiProactiveBriefReplayCandidateSummary {
  id: string;
  topicId: string;
  topicLabel: string;
  title: string;
  sourceCount: number;
  sourceHosts: string[];
  freshnessCannotKnow: string[];
  selectedMode: AoiProactiveBriefDeliveryDecision['selectedMode'];
  deliveryScore: number;
  chatHookAllowed: boolean;
  chatHookReasons: AoiProactiveBriefDeliverySuppressionReason[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReplayReport {
  version: 1;
  fixtureId: string;
  title: string;
  scenario: AoiProactiveBriefReplayScenario;
  generatedAt: number;
  passed: boolean;
  summary: string;
  metrics: AoiProactiveBriefReplayMetric[];
  candidates: AoiProactiveBriefReplayCandidateSummary[];
  candidateCount: number;
  visibleCardCount: number;
  warningLabels: string[];
  diagnosticLabels: AoiProactiveBriefDiagnosticCode[];
  diagnostics: AoiProactiveBriefDiagnostic[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReplayFixture {
  id: string;
  title: string;
  scenario: AoiProactiveBriefReplayScenario;
  now?: number;
  profile: AoiInterestProfile;
  policy?: AoiAutonomyPolicy;
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState;
  context?: AoiProactiveBriefDeliveryContext;
  searchResults?: AoiProactiveBriefRawSearchResult[];
  searchWarning?: string;
  skipSearch?: boolean;
  sourceStaleAfterMs?: number;
  directCandidates?: AoiProactiveBriefCandidate[];
  expectedPrivateTextAbsent?: string[];
}

export type AoiProactiveBriefReplayDraftStatus =
  | 'promoted_candidate'
  | 'blocked_private_leak'
  | 'blocked_unauthorized_mutation'
  | 'blocked_stale_current_claim'
  | 'blocked_unlabeled'
  | 'blocked_no_field_event'
  | 'blocked_no_source_evidence'
  | 'blocked_replay_failed';

export interface AoiProactiveBriefReplayFixtureDraft {
  version: 1;
  id: string;
  sessionPath: string;
  fieldEventId: string;
  calibrationLabelId: string;
  label: AoiProactiveBriefCalibrationLabel;
  status: AoiProactiveBriefReplayDraftStatus;
  fixture: AoiProactiveBriefReplayFixture;
  validation: {
    deterministicClock: boolean;
    noNetworkDependency: boolean;
    rawPrivateTextAbsent: boolean;
    hasSourceEvidence: boolean;
    expectedOutcome: string;
    blockers: string[];
  };
  redaction: {
    applied: boolean;
    removedPrivateFieldCount: number;
    removedRefs: string[];
  };
  evidenceRefs: string[];
  createdAt: number;
}

export interface BuildAoiProactiveBriefReplayPromotionDraftsInput {
  sessionPath: string;
  events: AoiProactiveBriefFieldEvent[];
  labels: AoiProactiveBriefCalibrationLabelRecord[];
  candidates?: AoiProactiveBriefCandidate[];
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  now?: number;
  maxDrafts?: number;
}

export type AoiProactiveBriefReadinessStatus =
  | 'ready'
  | 'blocked'
  | 'not_field_tested'
  | 'measuring';

export type AoiProactiveBriefDirectChatReadiness =
  | 'eligible_opt_in'
  | 'disabled_by_policy'
  | 'not_field_tested'
  | 'blocked_private_or_unsafe'
  | 'blocked_stale_current_claim'
  | 'lowered_by_feedback'
  | 'measuring';

export type AoiProactiveBriefCurrentProviderFreshnessState =
  | 'configured'
  | 'missing_provider'
  | 'not_required'
  | 'unknown';

export interface AoiProactiveBriefReadinessGate {
  id: string;
  status: 'pass' | 'warn' | 'block';
  summary: string;
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReadinessSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  status: AoiProactiveBriefReadinessStatus;
  sampleCount: number;
  minimumSampleCount: number;
  counts: {
    useful: number;
    tooFrequent: number;
    wrongTopic: number;
    wrongTiming: number;
    stale: number;
    unsafe: number;
    privateLeak: number;
    unauthorizedMutation: number;
    staleCurrentClaim: number;
  };
  suppressionCounts: Record<string, number>;
  replayPromotionCandidateCount: number;
  directChatReadiness: AoiProactiveBriefDirectChatReadiness;
  currentProviderFreshnessState: AoiProactiveBriefCurrentProviderFreshnessState;
  gates: AoiProactiveBriefReadinessGate[];
  summary: string;
  evidenceRefs: string[];
}

export interface BuildAoiProactiveBriefReadinessSummaryInput {
  sessionPath: string;
  metrics?: AoiProactiveBriefFieldMetrics | null;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  replayDrafts?: AoiProactiveBriefReplayFixtureDraft[];
  policy?: AoiAutonomyPolicy | null;
  tavilyConfigured?: boolean;
  now?: number;
  minimumSampleCount?: number;
}

export interface BuildAoiProactiveBriefDiagnosticsInput {
  profile?: AoiInterestProfile | null;
  candidates?: AoiProactiveBriefCandidate[];
  decisions?: AoiProactiveBriefDeliveryDecision[];
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState | null;
  scoutWarnings?: string[];
  skippedTopics?: AoiProactiveBriefSkippedTopic[];
  sourceFreshness?: AoiProactiveBriefSourceFreshness[];
  now?: number;
}
