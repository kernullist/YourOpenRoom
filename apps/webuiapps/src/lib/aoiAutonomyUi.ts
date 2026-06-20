import {
  AOI_AUTONOMY_LEVEL_ORDER,
  DEFAULT_AOI_AUTONOMY_POLICY,
  checkAoiEnvironmentSourceOperation,
  checkAoiProposalPolicy,
  isAoiPersonalSignalSourceKind,
} from './aoiAutonomyPolicy';
import {
  buildAoiMissionControlDashboardSummary,
  type AoiMissionControlDashboardSummary,
  type AoiMissionControlState,
} from './aoiMissionControlRuntime';
import { buildAoiMissionMemoryDashboardContext } from './aoiMissionMemory';
import { buildAoiPersonalSourceRealityDashboardContext } from './aoiPersonalSourceRealityCheck';
import { resolveAoiPreferenceContext } from './aoiPreferenceMemory';
import {
  buildAoiSourceFreshnessContracts,
  buildAoiSourceFreshnessDashboardContext,
  type AoiSourceFreshnessContract,
} from './aoiSourceFreshnessContract';
import {
  buildAoiJarvisReadinessScorecard,
  type AoiJarvisReadinessScorecard,
} from './aoiJarvisReadinessScorecard';
import type { AoiBoundedWorkOrder } from './aoiBoundedWorkOrder';
import type { AoiFieldShadowRecordReport } from './aoiFieldShadowDogfooding';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import type { AoiJarvisAcceptanceReport } from './aoiJarvisAcceptanceTrial';
import type { AoiMissionMemorySnapshot } from './aoiMissionMemory';
import type { AoiPersonalSourceRealityCheck } from './aoiPersonalSourceRealityCheck';
import type { AoiReplayReport } from './aoiOperatorReplay';
import type { AoiShadowDecisionReport } from './aoiShadowModeEvaluation';
import type { AoiOperatorFeedbackInbox } from './aoiOperatorFeedbackInbox';
import type {
  AoiAutonomyVisibleState,
  AoiAutonomyLevel,
  AoiAutonomyBlockedProposal,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiContextRouterResult,
  AoiContextSourceSummary,
  AoiEnvironmentSource,
  AoiEnvironmentSourceOperation,
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiApprovedCommandPolicy,
  AoiApprovedCommandResult,
  AoiOperatorDigest,
  AoiOperatorHealthState,
  AoiOperatorTimelineSummary,
  AoiPreparedActionPlan,
  AoiPlaybook,
  AoiProposal,
  AoiProposalDecision,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

export const AOI_INLINE_SUGGESTION_COOLDOWN_MS = 30 * 60 * 1000;
export const AOI_AGENDA_CHAT_NUDGE_COOLDOWN_MS = 45 * 60 * 1000;
export const AOI_AGENDA_NUDGE_TOO_MUCH_MUTE_MS = 2 * 60 * 60 * 1000;
export const AOI_AGENDA_NUDGE_QUIET_MUTE_MS = 6 * 60 * 60 * 1000;
export const AOI_AGENDA_NUDGE_FEEDBACK_HISTORY_MAX = 5;
export const AOI_INLINE_SUGGESTION_MAX_PER_SESSION = 3;
export const AOI_AUTONOMY_PANEL_SETTINGS_KEY = 'openroom-aoi-autonomy-panel-settings';

export const AOI_AUTONOMY_UI_LEVELS: AoiAutonomyLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

const RISK_SCORE: Record<AoiAutonomyRisk, number> = {
  low: 0.14,
  medium: 0,
  high: -0.22,
};

const WINDOWS_PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const UNIX_PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_TOKEN_PATTERN = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*['"]?[^'"\s,;]+/gi;

export interface AoiInlineProposalSelectionOptions {
  now?: number;
  dismissedProposalIds?: ReadonlySet<string>;
  snoozedProposalIds?: ReadonlySet<string>;
  lastShownAt?: number | null;
  shownCount?: number;
  maxPerSession?: number;
  cooldownMs?: number;
  quietMode?: boolean;
}

export type AoiAgendaChatNudgeReason =
  | 'accepted_action_ready'
  | 'approval_waiting'
  | 'blocked_gate'
  | 'high_signal_proposal';

export interface AoiAgendaChatNudge {
  dedupeKey: string;
  reason: AoiAgendaChatNudgeReason;
  proposalId?: string;
  chatText: string;
  suggestedReplies: string[];
  evidenceRefs: string[];
}

export interface AoiAgendaChatNudgeSelectionOptions {
  now?: number;
  lastShownAt?: number | null;
  shownCount?: number;
  maxPerSession?: number;
  cooldownMs?: number;
  quietMode?: boolean;
  notificationsEnabled?: boolean;
  shownDedupeKeys?: ReadonlySet<string>;
  calibration?: AoiAgendaNudgeCalibrationState | null;
}

export type AoiAgendaNudgeFeedbackKind = 'useful' | 'too_much' | 'quieted' | 'neutral';

export interface AoiAgendaNudgeCalibrationState {
  version: 1;
  updatedAt: number;
  usefulCount: number;
  noisyCount: number;
  quietedCount: number;
  neutralCount: number;
  mutedUntil: number | null;
  lastFeedbackKind: AoiAgendaNudgeFeedbackKind | null;
  lastFeedbackReason: string | null;
  lastDedupeKey: string | null;
}

export interface AoiAgendaNudgeCalibrationGate {
  suppressed: boolean;
  reasonLabels: string[];
  mutedUntil: number | null;
  evidenceRefs: string[];
}

export type AoiAgendaNudgeReadinessActionId =
  | 'enable_notifications'
  | 'disable_quiet_mode'
  | 'raise_session_cap'
  | 'reset_feedback_mute'
  | 'refresh_autonomy'
  | 'run_check';

export interface AoiAgendaNudgeReadinessAction {
  id: AoiAgendaNudgeReadinessActionId;
  label: string;
  title: string;
}

export type AoiAgendaNudgeDecisionFeedbackActionId =
  | 'mark_decision_useful'
  | 'mark_decision_too_much'
  | 'quiet_decision_nudges';

export interface AoiAgendaNudgeDecisionFeedbackAction {
  id: AoiAgendaNudgeDecisionFeedbackActionId;
  kind: AoiAgendaNudgeFeedbackKind;
  label: string;
  title: string;
  reason: string;
  dedupeKey: string;
  disabled: boolean;
}

export interface AoiAgendaNudgeDecisionFeedbackAudit {
  version: 1;
  actionId: AoiAgendaNudgeDecisionFeedbackActionId;
  kind: AoiAgendaNudgeFeedbackKind;
  actionLabel: string;
  reason: string;
  dedupeKey: string;
  recordedAt: number;
  safetyBoundary: string;
}

export interface AoiAgendaNudgeReadinessActionAudit {
  version: 1;
  actionId: AoiAgendaNudgeReadinessActionId;
  actionLabel: string;
  recordedAt: number;
  statusBefore: string;
  candidateBefore: string;
  safetyBoundary: string;
}

export type AoiAgendaNudgeDeliveryDecisionState = 'ready' | 'silent' | 'blocked';

export interface AoiAgendaNudgeDeliveryDecisionAudit {
  version: 1;
  recordedAt: number;
  state: AoiAgendaNudgeDeliveryDecisionState;
  statusLabel: string;
  candidateLabel: string;
  summaryLabel: string;
  decisionLabels: string[];
  evidenceRefs: string[];
  safetyBoundary: string;
}

export interface AoiAgendaNudgeReadinessPanelSummary {
  visible: boolean;
  statusLabel: string;
  summaryLabel: string;
  candidateLabel: string;
  deliveryDecisionLabels: string[];
  reasonLabels: string[];
  nextActionLabels: string[];
  actions: AoiAgendaNudgeReadinessAction[];
  lastActionLabels: string[];
  lastDecisionLabels: string[];
  lastDecisionFeedbackLabels: string[];
  decisionFeedbackHistoryLabels: string[];
  decisionFeedbackActions: AoiAgendaNudgeDecisionFeedbackAction[];
  evidenceRefs: string[];
  tone: 'ready' | 'waiting' | 'blocked';
}

export type AoiAgendaChatFollowUpIntent =
  | 'preview_prepared_action'
  | 'review_approval_gate'
  | 'explain_why_now'
  | 'show_safety_boundary'
  | 'explain_blocked_gate'
  | 'show_safe_alternative'
  | 'show_safe_next_step'
  | 'enable_quiet_mode';

export interface AoiAgendaChatFollowUpContext {
  prompt: string;
  nudge: AoiAgendaChatNudge;
  createdAt: number;
}

export interface AoiAgendaChatFollowUpResponse {
  intent: AoiAgendaChatFollowUpIntent;
  chatText: string;
  suggestedReplies: string[];
  evidenceRefs: string[];
  shouldEnableQuietMode: boolean;
  feedbackKind: AoiAgendaNudgeFeedbackKind;
}

export interface AoiAutonomyProposalCounts {
  active: number;
  dismissed: number;
  snoozed: number;
  blocked: number;
}

export interface AoiAutonomyPanelSettings {
  panelExpanded: boolean;
  notificationsEnabled: boolean;
  quietMode: boolean;
  maxSuggestionsPerSession: number;
  agendaNudgeCalibration?: AoiAgendaNudgeCalibrationState | null;
  agendaNudgeReadinessLastAction?: AoiAgendaNudgeReadinessActionAudit | null;
  agendaNudgeReadinessLastDecision?: AoiAgendaNudgeDeliveryDecisionAudit | null;
  agendaNudgeReadinessLastDecisionFeedback?: AoiAgendaNudgeDecisionFeedbackAudit | null;
  agendaNudgeReadinessDecisionFeedbackHistory?: AoiAgendaNudgeDecisionFeedbackAudit[];
}

export interface AoiAutonomyNotificationBadge {
  visible: boolean;
  label: string;
  why: string;
  reason: 'goal_proposal' | 'background_event' | 'blocked_action';
}

export interface AoiProposalInspectorSummary {
  title: string;
  reason: string;
  confidence: number;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: AoiAutonomyLevel;
  suggestedAction: string;
  policyAllowed: boolean;
  policyReasons: string[];
  evidenceRefs: string[];
  safeAlternative: string;
}

export interface AoiProactiveExplanation {
  whyNow: string;
  whatChanged: string;
  evidenceRefs: string[];
  evidenceSummary: string;
  evidenceCount: number;
  confidence: number;
  confidenceLabel: string;
  risk: AoiAutonomyRisk;
  safeNextAction: string;
  willNotDoWithoutApproval: string;
  oneLineRationale: string;
  messageSummary: string;
  approvalBoundary: string;
  details: string[];
  lowEvidence: boolean;
}

export interface AoiRecoveryPreviewSummary {
  visible: boolean;
  failureKind: string;
  rootCauseSummary: string;
  proposedActionLabel: string;
  whyNarrowerOrSafer: string;
  retryLabel: string;
  cooldownLabel: string;
  evidenceRefs: string[];
  nonGoals: string[];
}

export interface AoiMissionPanelSummary {
  visible: boolean;
  visibleState: AoiAutonomyVisibleState | null;
  statusLabel: string;
  waitingOnLabel: string;
  focusSummary: string;
  nextActionLabel: string;
  nextActionReason: string;
  evidenceCount: number;
  evidenceRefs: string[];
  canPause: boolean;
  canResume: boolean;
  canClear: boolean;
  pauseLabel: string;
  pauseTitle: string;
  resumeLabel: string;
  resumeTitle: string;
  showEvidenceLabel: string;
  showEvidenceTitle: string;
}

export interface AoiEnvironmentSourcePanelSummary {
  id: string;
  label: string;
  kindLabel: string;
  enabled: boolean;
  enabledLabel: string;
  scopeLabel: string;
  risk: AoiAutonomyRisk;
  riskLabel: string;
  privateLabel: string;
  operationsLabel: string;
  quietModeLabel: string;
  lastObservedLabel: string;
  lastReviewedLabel: string;
  consentSummary: string;
  metadataScopeLabel: string;
  willNotReadOrDoLabel: string;
  gateReason: string;
  canToggle: boolean;
  canClear: boolean;
  toggleTitle: string;
  clearTitle: string;
}

export interface AoiWorkspaceSignalPanelSummary {
  visible: boolean;
  workspaceLabel: string;
  sourceLabel: string;
  branchLabel: string;
  dirtyLabel: string;
  validationLabel: string;
  freshness: AoiWorkspaceSnapshot['freshness'];
  freshnessLabel: string;
  recommendationLabel: string;
  recommendationReason: string;
  recommendationTone: 'neutral' | 'recommendation';
  changedFileLabels: string[];
  evidenceRefs: string[];
  warningCount: number;
}

export interface AoiContextSourcePanelSummary {
  id: string;
  sourceId: string;
  label: string;
  kindLabel: string;
  displayNameLabel: string;
  scoreLabel: string;
  freshnessLabel: string;
  confidenceLabel: string;
  redactionLabel: string;
  summary: string;
  evidenceRefs: string[];
  scoreReasons: string[];
  wrongEvidenceTitle: string;
  wrongTimingTitle: string;
}

export interface AoiProposalActionPresentation {
  visibleState: AoiAutonomyVisibleState;
  primaryLabel: string;
  primaryTitle: string;
  primaryRole: 'approve' | 'preview' | 'execute' | 'none';
  mutationBoundary: string;
  requiresPreviewBeforeFinal: boolean;
  finalActionAvailable: boolean;
}

export interface AoiPreparedActionPlanPanelSummary {
  visible: boolean;
  statusLabel: string;
  actionKindLabel: string;
  objective: string;
  riskLabel: string;
  approvalLabel: string;
  checkpointLabel: string;
  validationLabel: string;
  rollbackLabel: string;
  expectedChanges: string[];
  affectedSurfaces: string[];
  validationCommands: string[];
  rollbackInstructions: string[];
  blockers: string[];
  nonGoals: string[];
  evidenceRefs: string[];
}

export interface AoiApprovedCommandPanelSummary {
  visible: boolean;
  statusLabel: string;
  commandLabel: string;
  cwdLabel: string;
  riskLabel: string;
  reasonLabels: string[];
  resultLabel: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  outputTruncated: boolean;
  evidenceRefs: string[];
}

export interface AoiPreferenceInfluencePanelSummary {
  visible: boolean;
  statusLabel: string;
  preferenceLabels: string[];
  conflictLabels: string[];
  demotionLabels: string[];
  sourceRefs: string[];
  availableActions: Array<'save' | 'demote' | 'archive' | 'mark_temporary'>;
}

export interface AoiOperatorDigestPanelSummary {
  visible: boolean;
  summaryLabel: string;
  laneLabels: string[];
  itemLabels: string[];
  approvalLabels: string[];
  resumeBriefLabel: string;
  hiddenLabel: string;
  evidenceRefs: string[];
}

export interface AoiOperatorHealthPanelSummary {
  visible: boolean;
  statusLabel: string;
  summaryLabel: string;
  capabilityLabels: string[];
  issueLabels: string[];
  recommendationLabels: string[];
  evidenceRefs: string[];
  tone: 'healthy' | 'limited' | 'degraded' | 'blocked';
}

export interface AoiPlaybookPanelSummary {
  visible: boolean;
  statusLabel: string;
  titleLabel: string;
  objectiveLabel: string;
  stepLabels: string[];
  boundaryLabels: string[];
  nextDecisionLabel: string;
  blockedPrerequisiteLabels: string[];
  evidenceRefs: string[];
  tone: 'neutral' | 'waiting' | 'blocked' | 'completed';
}

export interface AoiOperatorTimelinePanelSummary {
  visible: boolean;
  summaryLabel: string;
  eventLabels: string[];
  exportLabel: string;
  redactionLabel: string;
}

export interface AoiAutonomySchedulerPanelSummary {
  visible: boolean;
  summaryLabel: string;
  lastWakeupLabel: string;
  nextWakeupLabel: string;
  skippedSourceLabels: string[];
  warningLabels: string[];
  budgetLabel: string;
  evidenceRefs: string[];
}

export type AoiAutonomyAgendaPhaseKey = 'observe' | 'think' | 'propose' | 'act' | 'reflect';

export type AoiAutonomyAgendaTone = 'idle' | 'ready' | 'active' | 'waiting' | 'blocked' | 'muted';

export interface AoiAutonomyAgendaPhaseSummary {
  key: AoiAutonomyAgendaPhaseKey;
  label: string;
  statusLabel: string;
  primaryLabel: string;
  detailLabels: string[];
  evidenceRefs: string[];
  tone: AoiAutonomyAgendaTone;
}

export interface AoiAutonomyAgendaPanelSummary {
  visible: boolean;
  headlineLabel: string;
  loopLabel: string;
  nextBestActionLabel: string;
  safetyBoundaryLabel: string;
  approvalInboxLabel: string;
  phaseSummaries: AoiAutonomyAgendaPhaseSummary[];
  evidenceRefs: string[];
}

export interface AoiAgendaNudgeCalibrationPanelSummary {
  visible: boolean;
  statusLabel: string;
  summaryLabel: string;
  countLabels: string[];
  reasonLabels: string[];
  auditLabels: string[];
  evidenceRefs: string[];
  resetLabel: string;
  tone: 'neutral' | 'learning' | 'suppressed';
}

export interface AoiCurrentBriefPanel {
  visible: boolean;
  statusLabel: string;
  missionLabel: string;
  workspaceLabel: string;
  validationLabel: string;
  kiraLabel: string;
  evidenceRefs: string[];
}

export interface AoiBlindSpotsPanel {
  visible: boolean;
  statusLabel: string;
  blindSpotLabels: string[];
  sourceLabels: string[];
  evidenceRefs: string[];
}

export interface AoiSourceFreshnessPanel {
  visible: boolean;
  statusLabel: string;
  topStaleSourceLabels: string[];
  disconnectedSourceLabels: string[];
  revokedSourceLabels: string[];
  metadataOnlyBoundaryLabels: string[];
  lastObservedLabels: string[];
  lastSuccessfulReadLabels: string[];
  evidenceRefs: string[];
}

export interface AoiBoundedWorkOrderPanel {
  visible: boolean;
  statusLabel: string;
  eligibleWorkOrderLabels: string[];
  blockedReasonLabels: string[];
  exactNextApprovalLabels: string[];
  checkpointLabels: string[];
  rollbackLabels: string[];
  evidenceRefs: string[];
}

export interface AoiNextSafeActionPanel {
  visible: boolean;
  actionLabel: string;
  sourceLabel: string;
  boundaryLabel: string;
  blockedReasonLabels: string[];
  evidenceRefs: string[];
}

export interface AoiWhyQuietPanel {
  visible: boolean;
  reasonLabels: string[];
  quietDecisionRefs: string[];
  evidenceRefs: string[];
}

export interface AoiPendingApprovalPanel {
  visible: boolean;
  approvalLabels: string[];
  boundaryLabels: string[];
  riskLabels: string[];
  evidenceRefs: string[];
}

export interface AoiPromotedFixtureCandidateSummary {
  id: string;
  label: string;
  status: 'candidate' | 'promoted' | 'blocked' | 'deferred';
  evidenceRefs: string[];
}

export interface AoiReplayHealthPanel {
  visible: boolean;
  statusLabel: string;
  builtInReplayLabel: string;
  jarvisAcceptanceLabel: string;
  shadowLabel: string;
  failedMetricIds: string[];
  promotedFixtureLabels: string[];
  evidenceRefs: string[];
}

export interface AoiJarvisReadinessPanel {
  visible: boolean;
  statusLabel: string;
  levelLabel: string;
  scoreLabel: string;
  modeRecommendationLabel: string;
  gateLabels: string[];
  recommendationLabels: string[];
  evidenceRefs: string[];
}

export interface AoiOperatorFeedbackInboxPanel {
  visible: boolean;
  inboxCountLabel: string;
  unlabeledCountLabel: string;
  labelDistributionLabels: string[];
  topSourceKindLabels: string[];
  promotionCandidateLabel: string;
  calibrationInputLabel: string;
  evidenceRefs: string[];
}

export interface AoiOperatorAcceptanceDashboard {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  answerLabel: string;
  missionControl: AoiMissionControlDashboardSummary;
  currentBrief: AoiCurrentBriefPanel;
  blindSpots: AoiBlindSpotsPanel;
  sourceFreshness: AoiSourceFreshnessPanel;
  boundedWorkOrders: AoiBoundedWorkOrderPanel;
  nextSafeAction: AoiNextSafeActionPanel;
  whyQuiet: AoiWhyQuietPanel;
  pendingApproval: AoiPendingApprovalPanel;
  replayHealth: AoiReplayHealthPanel;
  jarvisReadiness: AoiJarvisReadinessPanel;
  feedbackInbox: AoiOperatorFeedbackInboxPanel;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiOperatorAcceptanceDashboardInput {
  sessionPath: string;
  now?: number;
  mission?: AoiMissionState | null;
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  health?: AoiOperatorHealthState | null;
  digest?: AoiOperatorDigest | null;
  timelineSummary?: AoiOperatorTimelineSummary | null;
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  sourceFreshnessContracts?: AoiSourceFreshnessContract[];
  boundedWorkOrders?: AoiBoundedWorkOrder[];
  playbooks?: AoiPlaybook[];
  missionControl?: AoiMissionControlState | null;
  missionMemory?: AoiMissionMemorySnapshot | null;
  personalSourceRealityCheck?: AoiPersonalSourceRealityCheck | null;
  approvedCommandPolicies?: AoiApprovedCommandPolicy[];
  approvedCommandResults?: AoiApprovedCommandResult[];
  builtInReplayReports?: AoiReplayReport[];
  jarvisAcceptanceReport?: AoiJarvisAcceptanceReport | null;
  jarvisReadinessScorecard?: AoiJarvisReadinessScorecard | null;
  fieldShadowReport?: AoiFieldShadowRecordReport | null;
  shadowReport?: AoiShadowDecisionReport | null;
  promotedFixtureCandidates?: AoiPromotedFixtureCandidateSummary[];
  feedbackInbox?: AoiOperatorFeedbackInbox | null;
}

export interface AoiBlockedStateSummary {
  policyReasons: string[];
  missingEvidence: string[];
  safeAlternative: string;
}

export const DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS: AoiAutonomyPanelSettings = {
  panelExpanded: true,
  notificationsEnabled: false,
  quietMode: false,
  maxSuggestionsPerSession: AOI_INLINE_SUGGESTION_MAX_PER_SESSION,
  agendaNudgeCalibration: null,
  agendaNudgeReadinessLastAction: null,
  agendaNudgeReadinessLastDecision: null,
  agendaNudgeReadinessLastDecisionFeedback: null,
  agendaNudgeReadinessDecisionFeedbackHistory: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function levelOrder(level: AoiAutonomyLevel): number {
  return AOI_AUTONOMY_LEVEL_ORDER[level] ?? 0;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeMaxSuggestions(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.round(clamp(value, 0, 12));
}

function normalizeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(clamp(value, 0, 1000));
}

function normalizeTimestampOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function normalizeAoiAgendaNudgeFeedbackKind(value: unknown): AoiAgendaNudgeFeedbackKind | null {
  return value === 'useful' || value === 'too_much' || value === 'quieted' || value === 'neutral'
    ? value
    : null;
}

function normalizeAoiAgendaNudgeReadinessActionId(
  value: unknown,
): AoiAgendaNudgeReadinessActionId | null {
  return value === 'enable_notifications' ||
    value === 'disable_quiet_mode' ||
    value === 'raise_session_cap' ||
    value === 'reset_feedback_mute' ||
    value === 'refresh_autonomy' ||
    value === 'run_check'
    ? value
    : null;
}

function normalizeAoiAgendaNudgeDeliveryDecisionState(
  value: unknown,
): AoiAgendaNudgeDeliveryDecisionState | null {
  return value === 'ready' || value === 'silent' || value === 'blocked' ? value : null;
}

function normalizeAoiAgendaNudgeDecisionFeedbackActionId(
  value: unknown,
): AoiAgendaNudgeDecisionFeedbackActionId | null {
  return value === 'mark_decision_useful' ||
    value === 'mark_decision_too_much' ||
    value === 'quiet_decision_nudges'
    ? value
    : null;
}

function normalizeAoiStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => sanitizeAoiProposalDisplayText(item, maxLength))
    .filter(Boolean);
}

export function normalizeAoiAgendaNudgeCalibration(
  value: unknown,
): AoiAgendaNudgeCalibrationState | null {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAgendaNudgeCalibrationState>)
      : null;
  if (!raw) {
    return null;
  }

  return {
    version: 1,
    updatedAt: normalizeTimestampOrNull(raw.updatedAt) ?? 0,
    usefulCount: normalizeCount(raw.usefulCount),
    noisyCount: normalizeCount(raw.noisyCount),
    quietedCount: normalizeCount(raw.quietedCount),
    neutralCount: normalizeCount(raw.neutralCount),
    mutedUntil: normalizeTimestampOrNull(raw.mutedUntil),
    lastFeedbackKind: normalizeAoiAgendaNudgeFeedbackKind(raw.lastFeedbackKind),
    lastFeedbackReason:
      typeof raw.lastFeedbackReason === 'string'
        ? sanitizeAoiProposalDisplayText(raw.lastFeedbackReason, 120)
        : null,
    lastDedupeKey:
      typeof raw.lastDedupeKey === 'string'
        ? sanitizeAoiProposalDisplayText(raw.lastDedupeKey, 160)
        : null,
  };
}

export function normalizeAoiAgendaNudgeReadinessActionAudit(
  value: unknown,
): AoiAgendaNudgeReadinessActionAudit | null {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAgendaNudgeReadinessActionAudit>)
      : null;
  if (!raw) {
    return null;
  }

  const actionId = normalizeAoiAgendaNudgeReadinessActionId(raw.actionId);
  const recordedAt = normalizeTimestampOrNull(raw.recordedAt);
  if (!actionId || !recordedAt) {
    return null;
  }

  return {
    version: 1,
    actionId,
    actionLabel:
      typeof raw.actionLabel === 'string'
        ? sanitizeAoiProposalDisplayText(raw.actionLabel, 120)
        : actionId.replace(/_/g, ' '),
    recordedAt,
    statusBefore:
      typeof raw.statusBefore === 'string'
        ? sanitizeAoiProposalDisplayText(raw.statusBefore, 120)
        : 'unknown',
    candidateBefore:
      typeof raw.candidateBefore === 'string'
        ? sanitizeAoiProposalDisplayText(raw.candidateBefore, 180)
        : 'unknown',
    safetyBoundary:
      typeof raw.safetyBoundary === 'string'
        ? sanitizeAoiProposalDisplayText(raw.safetyBoundary, 240)
        : 'Local readiness recovery only; no tools, app actions, policy bypass, or execution gates were run.',
  };
}

export function normalizeAoiAgendaNudgeDeliveryDecisionAudit(
  value: unknown,
): AoiAgendaNudgeDeliveryDecisionAudit | null {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAgendaNudgeDeliveryDecisionAudit>)
      : null;
  if (!raw) {
    return null;
  }

  const recordedAt = normalizeTimestampOrNull(raw.recordedAt);
  const state = normalizeAoiAgendaNudgeDeliveryDecisionState(raw.state);
  if (!recordedAt || !state) {
    return null;
  }

  return {
    version: 1,
    recordedAt,
    state,
    statusLabel:
      typeof raw.statusLabel === 'string'
        ? sanitizeAoiProposalDisplayText(raw.statusLabel, 120)
        : state,
    candidateLabel:
      typeof raw.candidateLabel === 'string'
        ? sanitizeAoiProposalDisplayText(raw.candidateLabel, 180)
        : 'unknown',
    summaryLabel:
      typeof raw.summaryLabel === 'string'
        ? sanitizeAoiProposalDisplayText(raw.summaryLabel, 220)
        : 'No delivery summary recorded.',
    decisionLabels: normalizeAoiStringList(raw.decisionLabels, 6, 260),
    evidenceRefs: normalizeAoiStringList(raw.evidenceRefs, 8, 180),
    safetyBoundary:
      typeof raw.safetyBoundary === 'string'
        ? sanitizeAoiProposalDisplayText(raw.safetyBoundary, 260)
        : 'Local delivery decision audit only; no tools, app actions, policy bypass, or execution gates were run.',
  };
}

export function normalizeAoiAgendaNudgeDecisionFeedbackAudit(
  value: unknown,
): AoiAgendaNudgeDecisionFeedbackAudit | null {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAgendaNudgeDecisionFeedbackAudit>)
      : null;
  if (!raw) {
    return null;
  }

  const actionId = normalizeAoiAgendaNudgeDecisionFeedbackActionId(raw.actionId);
  const kind = normalizeAoiAgendaNudgeFeedbackKind(raw.kind);
  const recordedAt = normalizeTimestampOrNull(raw.recordedAt);
  const dedupeKey =
    typeof raw.dedupeKey === 'string' ? sanitizeAoiProposalDisplayText(raw.dedupeKey, 160) : '';
  if (!actionId || !kind || !recordedAt || !dedupeKey) {
    return null;
  }

  return {
    version: 1,
    actionId,
    kind,
    actionLabel:
      typeof raw.actionLabel === 'string'
        ? sanitizeAoiProposalDisplayText(raw.actionLabel, 120)
        : actionId.replace(/_/g, ' '),
    reason:
      typeof raw.reason === 'string'
        ? sanitizeAoiProposalDisplayText(raw.reason, 160)
        : 'delivery decision feedback',
    dedupeKey,
    recordedAt,
    safetyBoundary:
      typeof raw.safetyBoundary === 'string'
        ? sanitizeAoiProposalDisplayText(raw.safetyBoundary, 260)
        : 'Local delivery feedback only; no tools, app actions, policy bypass, or execution gates were run.',
  };
}

function getAoiAgendaNudgeDecisionFeedbackAuditKey(
  audit: AoiAgendaNudgeDecisionFeedbackAudit,
): string {
  return `${audit.actionId}:${audit.dedupeKey}`;
}

export function normalizeAoiAgendaNudgeDecisionFeedbackHistory(
  value: unknown,
): AoiAgendaNudgeDecisionFeedbackAudit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  return value
    .map((item) => normalizeAoiAgendaNudgeDecisionFeedbackAudit(item))
    .filter((item): item is AoiAgendaNudgeDecisionFeedbackAudit => Boolean(item))
    .sort((left, right) => right.recordedAt - left.recordedAt)
    .filter((item) => {
      const key = getAoiAgendaNudgeDecisionFeedbackAuditKey(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, AOI_AGENDA_NUDGE_FEEDBACK_HISTORY_MAX);
}

export function appendAoiAgendaNudgeDecisionFeedbackHistory(
  history: AoiAgendaNudgeDecisionFeedbackAudit[] | null | undefined,
  audit: AoiAgendaNudgeDecisionFeedbackAudit | null | undefined,
): AoiAgendaNudgeDecisionFeedbackAudit[] {
  const normalizedAudit = normalizeAoiAgendaNudgeDecisionFeedbackAudit(audit);
  const normalizedHistory = normalizeAoiAgendaNudgeDecisionFeedbackHistory(history);
  if (!normalizedAudit) {
    return normalizedHistory;
  }

  const auditKey = getAoiAgendaNudgeDecisionFeedbackAuditKey(normalizedAudit);
  if (
    normalizedHistory.some((item) => getAoiAgendaNudgeDecisionFeedbackAuditKey(item) === auditKey)
  ) {
    return normalizedHistory;
  }

  return normalizeAoiAgendaNudgeDecisionFeedbackHistory([normalizedAudit, ...normalizedHistory]);
}

export function buildAoiAgendaNudgeFeedbackResetPatch(): Pick<
  AoiAutonomyPanelSettings,
  | 'agendaNudgeCalibration'
  | 'agendaNudgeReadinessLastDecisionFeedback'
  | 'agendaNudgeReadinessDecisionFeedbackHistory'
> {
  return {
    agendaNudgeCalibration: null,
    agendaNudgeReadinessLastDecisionFeedback: null,
    agendaNudgeReadinessDecisionFeedbackHistory: [],
  };
}

export function normalizeAoiAutonomyPanelSettings(
  value: unknown,
  fallback: AoiAutonomyPanelSettings = DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS,
): AoiAutonomyPanelSettings {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomyPanelSettings>)
      : {};
  const hasDecisionFeedbackHistory = Object.prototype.hasOwnProperty.call(
    raw,
    'agendaNudgeReadinessDecisionFeedbackHistory',
  );
  const normalizedDecisionFeedbackHistory = normalizeAoiAgendaNudgeDecisionFeedbackHistory(
    raw.agendaNudgeReadinessDecisionFeedbackHistory,
  );

  return {
    panelExpanded: normalizeBoolean(raw.panelExpanded, fallback.panelExpanded),
    notificationsEnabled: normalizeBoolean(raw.notificationsEnabled, fallback.notificationsEnabled),
    quietMode: normalizeBoolean(raw.quietMode, fallback.quietMode),
    maxSuggestionsPerSession: normalizeMaxSuggestions(
      raw.maxSuggestionsPerSession,
      fallback.maxSuggestionsPerSession,
    ),
    agendaNudgeCalibration:
      normalizeAoiAgendaNudgeCalibration(raw.agendaNudgeCalibration) ??
      fallback.agendaNudgeCalibration ??
      null,
    agendaNudgeReadinessLastAction:
      normalizeAoiAgendaNudgeReadinessActionAudit(raw.agendaNudgeReadinessLastAction) ??
      fallback.agendaNudgeReadinessLastAction ??
      null,
    agendaNudgeReadinessLastDecision:
      normalizeAoiAgendaNudgeDeliveryDecisionAudit(raw.agendaNudgeReadinessLastDecision) ??
      fallback.agendaNudgeReadinessLastDecision ??
      null,
    agendaNudgeReadinessLastDecisionFeedback:
      normalizeAoiAgendaNudgeDecisionFeedbackAudit(raw.agendaNudgeReadinessLastDecisionFeedback) ??
      fallback.agendaNudgeReadinessLastDecisionFeedback ??
      null,
    agendaNudgeReadinessDecisionFeedbackHistory: hasDecisionFeedbackHistory
      ? normalizedDecisionFeedbackHistory
      : normalizeAoiAgendaNudgeDecisionFeedbackHistory(
          fallback.agendaNudgeReadinessDecisionFeedbackHistory,
        ),
  };
}

export function loadAoiAutonomyPanelSettings(
  storage?: Pick<Storage, 'getItem'> | null,
): AoiAutonomyPanelSettings {
  const resolvedStorage =
    storage ??
    (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined);
  if (!resolvedStorage) {
    return DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  }
  try {
    return normalizeAoiAutonomyPanelSettings(
      JSON.parse(resolvedStorage.getItem(AOI_AUTONOMY_PANEL_SETTINGS_KEY) || 'null') as unknown,
    );
  } catch {
    return DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  }
}

export function saveAoiAutonomyPanelSettings(
  settings: AoiAutonomyPanelSettings,
  storage?: Pick<Storage, 'setItem'> | null,
): AoiAutonomyPanelSettings {
  const normalized = normalizeAoiAutonomyPanelSettings(settings);
  const resolvedStorage =
    storage ??
    (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined);
  if (!resolvedStorage) {
    return normalized;
  }
  try {
    resolvedStorage.setItem(AOI_AUTONOMY_PANEL_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // Persistence is best-effort.
  }
  return normalized;
}

export function recordAoiAgendaNudgeFeedback(
  calibration: AoiAgendaNudgeCalibrationState | null | undefined,
  params: {
    kind: AoiAgendaNudgeFeedbackKind;
    now?: number;
    reason?: string;
    dedupeKey?: string;
  },
): AoiAgendaNudgeCalibrationState {
  const now = params.now ?? Date.now();
  const current = normalizeAoiAgendaNudgeCalibration(calibration) ?? {
    version: 1,
    updatedAt: 0,
    usefulCount: 0,
    noisyCount: 0,
    quietedCount: 0,
    neutralCount: 0,
    mutedUntil: null,
    lastFeedbackKind: null,
    lastFeedbackReason: null,
    lastDedupeKey: null,
  };
  const dedupeKey = params.dedupeKey ? sanitizeAoiProposalDisplayText(params.dedupeKey, 160) : null;
  if (
    dedupeKey &&
    current.lastDedupeKey === dedupeKey &&
    current.lastFeedbackKind === params.kind
  ) {
    return current;
  }

  const next: AoiAgendaNudgeCalibrationState = {
    ...current,
    updatedAt: now,
    lastFeedbackKind: params.kind,
    lastFeedbackReason: params.reason
      ? sanitizeAoiProposalDisplayText(params.reason, 120)
      : current.lastFeedbackReason,
    lastDedupeKey: dedupeKey ?? current.lastDedupeKey,
  };

  if (params.kind === 'useful') {
    next.usefulCount += 1;
    next.mutedUntil = null;
  } else if (params.kind === 'too_much') {
    next.noisyCount += 1;
    next.mutedUntil = now + AOI_AGENDA_NUDGE_TOO_MUCH_MUTE_MS;
  } else if (params.kind === 'quieted') {
    next.quietedCount += 1;
    next.mutedUntil = now + AOI_AGENDA_NUDGE_QUIET_MUTE_MS;
  } else {
    next.neutralCount += 1;
  }

  return next;
}

export function getAoiAgendaNudgeCalibrationGate(
  calibration: AoiAgendaNudgeCalibrationState | null | undefined,
  now = Date.now(),
): AoiAgendaNudgeCalibrationGate {
  const normalized = normalizeAoiAgendaNudgeCalibration(calibration);
  if (!normalized) {
    return {
      suppressed: false,
      reasonLabels: [],
      mutedUntil: null,
      evidenceRefs: [],
    };
  }

  const mutedUntil =
    normalized.mutedUntil && normalized.mutedUntil > now ? normalized.mutedUntil : null;
  const reasonLabels: string[] = [];
  const evidenceRefs = [`agenda-feedback:${normalized.lastFeedbackKind ?? 'none'}`];

  if (mutedUntil) {
    const kindLabel = normalized.lastFeedbackKind
      ? normalized.lastFeedbackKind.replace(/_/g, ' ')
      : 'recent feedback';
    reasonLabels.push(`Agenda nudges muted after ${kindLabel} feedback.`);
    reasonLabels.push(`Muted until ${new Date(mutedUntil).toLocaleString()}.`);
  }
  if (normalized.usefulCount > 0) {
    reasonLabels.push(`${normalized.usefulCount} useful agenda response(s) recorded.`);
  }
  if (normalized.noisyCount + normalized.quietedCount > 0) {
    reasonLabels.push(
      `${normalized.noisyCount + normalized.quietedCount} quiet/noisy agenda response(s) recorded.`,
    );
  }

  return {
    suppressed: Boolean(mutedUntil),
    reasonLabels,
    mutedUntil,
    evidenceRefs,
  };
}

export function buildAoiAgendaNudgeCalibrationPanelSummary(
  settings: AoiAutonomyPanelSettings | null | undefined,
  now = Date.now(),
): AoiAgendaNudgeCalibrationPanelSummary {
  const calibration = normalizeAoiAgendaNudgeCalibration(settings?.agendaNudgeCalibration);
  const lastDecisionFeedback = normalizeAoiAgendaNudgeDecisionFeedbackAudit(
    settings?.agendaNudgeReadinessLastDecisionFeedback,
  );
  const feedbackHistory = normalizeAoiAgendaNudgeDecisionFeedbackHistory(
    settings?.agendaNudgeReadinessDecisionFeedbackHistory,
  );
  const auditLabels = [
    ...buildAoiAgendaNudgeLastDecisionFeedbackLabels(lastDecisionFeedback),
    ...buildAoiAgendaNudgeDecisionFeedbackHistoryLabels(feedbackHistory),
  ];
  const hasFeedbackSurface = Boolean(calibration || lastDecisionFeedback || feedbackHistory.length);
  const gate = getAoiAgendaNudgeCalibrationGate(calibration, now);

  if (!calibration) {
    return {
      visible: true,
      statusLabel: 'untrained',
      summaryLabel: hasFeedbackSurface
        ? 'Direct agenda nudge feedback audit data is recorded, but no active calibration is applied.'
        : 'No direct agenda nudge feedback has been recorded yet.',
      countLabels: ['0 useful', '0 quiet/noisy'],
      reasonLabels: hasFeedbackSurface
        ? [
            'No local suppression is active.',
            'A local feedback audit trail is still available for reset.',
          ]
        : ['No local suppression is active.'],
      auditLabels,
      evidenceRefs: hasFeedbackSurface ? ['agenda-feedback:audit-trail'] : [],
      resetLabel: hasFeedbackSurface ? 'Reset agenda nudge feedback' : 'Nothing to reset',
      tone: 'neutral',
    };
  }

  const quietCount = calibration.noisyCount + calibration.quietedCount;
  const countLabels = [
    `${calibration.usefulCount} useful`,
    `${quietCount} quiet/noisy`,
    `${calibration.neutralCount} neutral`,
  ];
  const statusLabel = gate.suppressed
    ? 'muted'
    : calibration.usefulCount > 0
      ? 'learning'
      : 'watching';
  const summaryLabel = gate.suppressed
    ? 'Direct agenda nudges are temporarily muted by recent feedback.'
    : calibration.usefulCount > 0
      ? 'Direct agenda nudges are using positive local feedback.'
      : 'Direct agenda nudges are recording local feedback.';
  const reasonLabels = gate.suppressed
    ? gate.reasonLabels
    : [
        'No local suppression is active.',
        ...(gate.reasonLabels.length > 0
          ? gate.reasonLabels
          : ['Useful feedback clears temporary nudge mutes.']),
      ];

  return {
    visible: true,
    statusLabel,
    summaryLabel,
    countLabels,
    reasonLabels,
    auditLabels,
    evidenceRefs: gate.evidenceRefs,
    resetLabel: 'Reset agenda nudge feedback',
    tone: gate.suppressed ? 'suppressed' : 'learning',
  };
}

export function sanitizeAoiProposalDisplayText(value: string, maxLength = 520): string {
  const withoutPrivatePaths = value
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[private secret]')
    .replace(SECRET_TOKEN_PATTERN, '[private secret]')
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[private secret]`)
    .replace(WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(UNIX_PRIVATE_PATH_PATTERN, '[local path]');
  const compact = withoutPrivatePaths.replace(/\s+/g, ' ').trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function formatAoiEvidenceSummary(evidenceCount: number): string {
  if (evidenceCount <= 0) {
    return 'Limited evidence: no evidence refs are attached yet.';
  }
  return `${evidenceCount} evidence ref${evidenceCount === 1 ? '' : 's'} attached; details stay in the panel.`;
}

function getAoiConfidenceLabel(confidence: number, evidenceCount: number): string {
  if (evidenceCount <= 0 || confidence < 0.55) {
    return 'low evidence';
  }
  if (confidence < 0.7) {
    return 'moderate confidence';
  }
  return 'good confidence';
}

function triggerLabel(trigger: string): string {
  const normalized = sanitizeAoiProposalDisplayText(trigger.replace(/[_-]+/g, ' '), 80);
  return normalized || 'background check';
}

function describeAoiProposalChange(proposal: AoiProposal, policyReasons: string[]): string {
  if (proposal.blockedReason || policyReasons.length > 0 || proposal.status === 'blocked') {
    return 'A policy or evidence gate is blocking the next step.';
  }
  if (proposal.recoveryPreview) {
    return `A narrower recovery proposal is available after ${proposal.recoveryPreview.failureKind.replace(/_/g, ' ')}.`;
  }
  if (proposal.trigger === 'attention_broker') {
    return 'A background event surfaced a proposal worth reviewing.';
  }
  if (proposal.trigger === 'kira_outcome_followup') {
    return 'Reviewed Kira work produced one follow-up note.';
  }
  if (proposal.trigger === 'goal_continuation') {
    return 'The active goal has a proposed next step.';
  }
  if (proposal.evidenceRefs.length <= 0) {
    return 'A proposal exists, but supporting evidence is incomplete.';
  }
  return `A ${triggerLabel(proposal.trigger)} proposal is ready for review.`;
}

function getAoiApprovalBoundary(
  proposal: AoiProposal,
  action: AoiProposalActionPresentation,
): string {
  if (proposal.acceptAction?.kind === 'create_kira_work') {
    return 'I will not edit files directly; approval only creates one reviewed Kira work item.';
  }
  if (proposal.acceptAction?.kind === 'start_research') {
    return 'I will not start a research run without explicit approval.';
  }
  if (proposal.acceptAction?.kind === 'save_memory') {
    return 'I will not promote memory or create a skill draft without explicit approval.';
  }
  if (proposal.risk === 'high') {
    return 'High-risk work needs fresh explicit approval before any action.';
  }
  if (proposal.requiresUserApproval || proposal.acceptAction) {
    return 'I will not run tools or change state without explicit approval.';
  }
  if (action.primaryRole === 'none') {
    return 'This explanation does not run tools or change state.';
  }
  return action.mutationBoundary;
}

export function buildAoiProactiveExplanation(params: {
  proposal: AoiProposal;
  policy?: AoiAutonomyPolicy | null;
  activeProposals?: AoiProposal[];
  includeEvidence?: boolean;
  hasKiraPreview?: boolean;
  now?: number;
}): AoiProactiveExplanation {
  const policy = params.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const policyResult = checkAoiProposalPolicy({
    policy,
    proposal: params.proposal,
    activeProposals: params.activeProposals,
    now: params.now,
  });
  const action = buildAoiProposalActionPresentation(params.proposal, {
    hasKiraPreview: params.hasKiraPreview,
  });
  const evidenceCount = params.proposal.evidenceRefs.length;
  const lowEvidence = evidenceCount <= 0 || params.proposal.confidence < 0.55;
  const reason = sanitizeAoiProposalDisplayText(params.proposal.reason, 180);
  const whyNow = lowEvidence
    ? `Limited evidence: ${reason || 'this should stay as a suggestion.'}`
    : reason;
  const whatChanged = sanitizeAoiProposalDisplayText(
    describeAoiProposalChange(params.proposal, policyResult.reasons),
    180,
  );
  const safeNextAction = sanitizeAoiProposalDisplayText(action.primaryLabel, 120);
  const approvalBoundary = sanitizeAoiProposalDisplayText(
    getAoiApprovalBoundary(params.proposal, action),
    180,
  );
  const evidenceSummary = formatAoiEvidenceSummary(evidenceCount);
  const confidenceLabel = getAoiConfidenceLabel(params.proposal.confidence, evidenceCount);
  const oneLineRationale = sanitizeAoiProposalDisplayText(
    lowEvidence ? `Low evidence, review first: ${reason || whatChanged}` : reason || whatChanged,
    180,
  );
  const details = [
    `Body: ${params.proposal.body}`,
    `Reason: ${params.proposal.reason}`,
    `Policy: ${policyResult.allowed ? 'allowed' : 'blocked'}`,
    policyResult.reasons.length > 0 ? `Policy reasons: ${policyResult.reasons.join(' / ')}` : '',
    `Trigger: ${params.proposal.trigger}`,
    `Cooldown: ${params.proposal.cooldownKey}`,
  ]
    .filter(Boolean)
    .map((item) => sanitizeAoiProposalDisplayText(item, 260));
  const messageSummary = sanitizeAoiProposalDisplayText(
    [
      `Why now: ${whyNow}`,
      `Changed: ${whatChanged}`,
      `Evidence: ${evidenceSummary}`,
      `Next: ${safeNextAction}`,
      `Boundary: ${approvalBoundary}`,
    ].join(' '),
    520,
  );

  return {
    whyNow,
    whatChanged,
    evidenceRefs: params.includeEvidence
      ? params.proposal.evidenceRefs
          .slice(0, 8)
          .map((ref) => sanitizeAoiProposalDisplayText(ref, 220))
      : [],
    evidenceSummary,
    evidenceCount,
    confidence: params.proposal.confidence,
    confidenceLabel,
    risk: params.proposal.risk,
    safeNextAction,
    willNotDoWithoutApproval: approvalBoundary,
    oneLineRationale,
    messageSummary,
    approvalBoundary,
    details,
    lowEvidence,
  };
}

export function buildAoiBlockedProactiveExplanation(params: {
  blockedProposal: AoiAutonomyBlockedProposal;
  includeEvidence?: boolean;
}): AoiProactiveExplanation {
  const blockedSummary = buildAoiBlockedStateSummary({
    blockedProposal: params.blockedProposal,
  });
  const evidenceCount = params.blockedProposal.evidenceRefs.length;
  const whyNow = blockedSummary.policyReasons[0] ?? 'A background proposal was blocked by policy.';
  const whatChanged = 'A policy or evidence gate stopped the proposal before execution.';
  const safeNextAction = blockedSummary.safeAlternative;
  const approvalBoundary = 'No tools run from a blocked proposal; resolve the policy gate first.';
  const evidenceSummary = formatAoiEvidenceSummary(evidenceCount);
  const details = [
    ...blockedSummary.policyReasons.map((reason) => `Policy reason: ${reason}`),
    ...blockedSummary.missingEvidence.map((item) => `Missing evidence: ${item}`),
    `Safe alternative: ${blockedSummary.safeAlternative}`,
  ].map((item) => sanitizeAoiProposalDisplayText(item, 260));
  const messageSummary = sanitizeAoiProposalDisplayText(
    [
      `Why now: ${whyNow}`,
      `Changed: ${whatChanged}`,
      `Evidence: ${evidenceSummary}`,
      `Next: ${safeNextAction}`,
      `Boundary: ${approvalBoundary}`,
    ].join(' '),
    520,
  );

  return {
    whyNow: sanitizeAoiProposalDisplayText(whyNow, 180),
    whatChanged,
    evidenceRefs: params.includeEvidence
      ? params.blockedProposal.evidenceRefs
          .slice(0, 8)
          .map((ref) => sanitizeAoiProposalDisplayText(ref, 220))
      : [],
    evidenceSummary,
    evidenceCount,
    confidence: 0,
    confidenceLabel: evidenceCount > 0 ? 'blocked by policy' : 'blocked with limited evidence',
    risk: params.blockedProposal.risk ?? 'medium',
    safeNextAction,
    willNotDoWithoutApproval: approvalBoundary,
    oneLineRationale: sanitizeAoiProposalDisplayText(whyNow, 180),
    messageSummary,
    approvalBoundary,
    details,
    lowEvidence: evidenceCount <= 0,
  };
}

export function rankAoiProposal(
  proposal: AoiProposal,
  policy: AoiAutonomyPolicy = DEFAULT_AOI_AUTONOMY_POLICY,
): number {
  const confidenceScore = clamp(proposal.confidence, 0, 1);
  const evidenceScore = clamp(proposal.evidenceRefs.length, 0, 6) * 0.025;
  const toolScore = clamp(proposal.suggestedTools.length, 0, 4) * 0.01;
  const requiredLevelPenalty =
    Math.max(0, levelOrder(proposal.requiredAutonomyLevel) - levelOrder(policy.level)) * 0.08;
  const approvalPenalty = proposal.requiresUserApproval ? 0.01 : 0;

  return (
    confidenceScore +
    RISK_SCORE[proposal.risk] +
    evidenceScore +
    toolScore -
    requiredLevelPenalty -
    approvalPenalty
  );
}

export function canShowAoiProposalPrimaryAction(proposal: AoiProposal, now = Date.now()): boolean {
  if (proposal.status !== 'active') {
    return false;
  }
  if (proposal.blockedReason) {
    return false;
  }
  if (proposal.expiresAt && proposal.expiresAt <= now) {
    return false;
  }
  if (proposal.snoozedUntil && proposal.snoozedUntil > now) {
    return false;
  }
  return true;
}

export function isAoiProposalInlineEligible(
  proposal: AoiProposal,
  options: Pick<
    AoiInlineProposalSelectionOptions,
    'now' | 'dismissedProposalIds' | 'snoozedProposalIds'
  > = {},
): boolean {
  const now = options.now ?? Date.now();
  if (!canShowAoiProposalPrimaryAction(proposal, now)) {
    return false;
  }
  if (options.dismissedProposalIds?.has(proposal.id)) {
    return false;
  }
  if (options.snoozedProposalIds?.has(proposal.id)) {
    return false;
  }
  return true;
}

export function selectAoiInlineProposal(
  proposals: AoiProposal[],
  policy: AoiAutonomyPolicy | null | undefined,
  options: AoiInlineProposalSelectionOptions = {},
): AoiProposal | null {
  const resolvedPolicy = policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  if (options.quietMode) {
    return null;
  }
  if (!resolvedPolicy.enabled || !resolvedPolicy.proactiveSuggestionsEnabled) {
    return null;
  }

  const now = options.now ?? Date.now();
  const maxPerSession = options.maxPerSession ?? AOI_INLINE_SUGGESTION_MAX_PER_SESSION;
  const shownCount = options.shownCount ?? 0;
  if (shownCount >= maxPerSession) {
    return null;
  }

  const cooldownMs = options.cooldownMs ?? AOI_INLINE_SUGGESTION_COOLDOWN_MS;
  if (options.lastShownAt && now - options.lastShownAt < cooldownMs) {
    return null;
  }

  const eligible = proposals.filter((proposal) =>
    isAoiProposalInlineEligible(proposal, {
      now,
      dismissedProposalIds: options.dismissedProposalIds,
      snoozedProposalIds: options.snoozedProposalIds,
    }),
  );

  eligible.sort((left, right) => {
    const scoreDelta =
      rankAoiProposal(right, resolvedPolicy) - rankAoiProposal(left, resolvedPolicy);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return right.updatedAt - left.updatedAt;
  });

  return eligible[0] ?? null;
}

function proposalTiedToGoal(proposal: AoiProposal): boolean {
  return (
    proposal.trigger === 'goal_continuation' ||
    proposal.artifactRefs.some((ref) => ref.startsWith('goal:')) ||
    proposal.evidenceRefs.some((ref) => ref.startsWith('goal:'))
  );
}

export function buildAoiAutonomyNotificationBadge(params: {
  status?: AoiAutonomyStatus | null;
  proposals: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  settings?: AoiAutonomyPanelSettings;
}): AoiAutonomyNotificationBadge | null {
  const settings = params.settings ?? DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  if (settings.quietMode) {
    return null;
  }
  const goalProposalCount = params.proposals.filter(
    (proposal) =>
      proposal.status === 'active' &&
      proposal.risk !== 'high' &&
      canShowAoiProposalPrimaryAction(proposal) &&
      proposalTiedToGoal(proposal),
  ).length;
  if (goalProposalCount > 0) {
    const topGoalProposal = params.proposals.find(
      (proposal) =>
        proposal.status === 'active' &&
        proposal.risk !== 'high' &&
        canShowAoiProposalPrimaryAction(proposal) &&
        proposalTiedToGoal(proposal),
    );
    return {
      visible: true,
      label: `${goalProposalCount} goal proposal${goalProposalCount === 1 ? '' : 's'}`,
      why: topGoalProposal
        ? sanitizeAoiProposalDisplayText(topGoalProposal.reason, 180)
        : 'A goal-linked proposal has a safe next step.',
      reason: 'goal_proposal',
    };
  }
  if ((params.blockedProposals?.length ?? 0) > 0) {
    return {
      visible: true,
      label: `${params.blockedProposals?.length ?? 0} blocked`,
      why: sanitizeAoiProposalDisplayText(
        params.blockedProposals?.[0]?.safeAlternative ||
          params.blockedProposals?.[0]?.reasons.join(' / ') ||
          'A background action was blocked by policy.',
        180,
      ),
      reason: 'blocked_action',
    };
  }
  if ((params.status?.proposalsCreatedInLastTick ?? 0) > 0) {
    const attentionProposal = params.proposals.find(
      (proposal) => proposal.trigger === 'attention_broker',
    );
    return {
      visible: true,
      label: attentionProposal
        ? `${params.status?.proposalsCreatedInLastTick ?? 0} attention update`
        : `${params.status?.proposalsCreatedInLastTick ?? 0} new`,
      why: attentionProposal
        ? sanitizeAoiProposalDisplayText(attentionProposal.reason, 180)
        : 'A background check created a new proposal.',
      reason: 'background_event',
    };
  }
  if ((params.status?.recentObservationCount ?? 0) > 0) {
    return {
      visible: true,
      label: `${params.status?.recentObservationCount ?? 0} event${
        params.status?.recentObservationCount === 1 ? '' : 's'
      }`,
      why: 'Background events were recorded silently; open details for evidence.',
      reason: 'background_event',
    };
  }
  return null;
}

export function getAoiSafeAlternativeForReasons(
  proposal: Pick<AoiProposal, 'requiredAutonomyLevel' | 'requiresUserApproval' | 'risk'>,
  reasons: string[],
): string {
  if (reasons.some((reason) => reason.includes('kira_handoff_scope_too_broad'))) {
    return 'Narrow the Kira handoff to one accepted task with 1-3 modules and explicit non-goals.';
  }
  if (reasons.some((reason) => reason.includes('kira_handoff_requires_accepted_proposal'))) {
    return 'Accept the proposal before preparing a Kira handoff.';
  }
  if (reasons.some((reason) => reason.includes('autonomy_level_too_low'))) {
    return `Raise autonomy to ${proposal.requiredAutonomyLevel} or keep this as a proposal.`;
  }
  if (reasons.some((reason) => reason.includes('missing_fresh_acceptance'))) {
    return 'Accept the proposal again before execution.';
  }
  if (
    proposal.requiresUserApproval ||
    reasons.some((reason) => reason.includes('requires_approval'))
  ) {
    return 'Use explicit approval before continuing.';
  }
  if (proposal.risk === 'high') {
    return 'Review evidence and keep execution manual.';
  }
  if (reasons.some((reason) => reason.includes('cooldown'))) {
    return 'Wait for cooldown or run a manual check later.';
  }
  return 'Inspect the evidence and keep the action as a proposal.';
}

function getAoiMissingEvidenceLabels(reasons: string[], evidenceCount?: number): string[] {
  const labels: string[] = [];
  const add = (label: string) => {
    if (!labels.includes(label)) {
      labels.push(label);
    }
  };

  if (reasons.some((reason) => reason.includes('missing_evidence_refs'))) {
    add('Evidence refs are missing.');
  }
  if (reasons.some((reason) => reason.includes('missing_fresh_acceptance'))) {
    add('Fresh explicit acceptance is missing.');
  }
  if (reasons.some((reason) => reason.includes('kira_handoff_requires_accepted_proposal'))) {
    add('An accepted proposal is required before Kira handoff.');
  }
  if (typeof evidenceCount === 'number' && evidenceCount === 0 && reasons.length > 0) {
    add('No evidence refs are attached to this blocked action.');
  }

  return labels;
}

export function buildAoiBlockedStateSummary(params: {
  proposal?: Pick<
    AoiProposal,
    'requiredAutonomyLevel' | 'requiresUserApproval' | 'risk' | 'evidenceRefs' | 'blockedReason'
  > | null;
  blockedProposal?: Pick<
    AoiAutonomyBlockedProposal,
    | 'reasons'
    | 'evidenceRefs'
    | 'safeAlternative'
    | 'requiredAutonomyLevel'
    | 'requiresUserApproval'
    | 'risk'
  > | null;
  reasons?: string[];
}): AoiBlockedStateSummary {
  const rawReasons =
    params.reasons ??
    params.blockedProposal?.reasons ??
    (params.proposal?.blockedReason ? [params.proposal.blockedReason] : []);
  const policyReasons = rawReasons.map((reason) => sanitizeAoiProposalDisplayText(reason, 180));
  const proposalForAlternative = params.proposal ?? {
    requiredAutonomyLevel: params.blockedProposal?.requiredAutonomyLevel ?? 'L1',
    requiresUserApproval: params.blockedProposal?.requiresUserApproval ?? true,
    risk: params.blockedProposal?.risk ?? 'medium',
  };
  const evidenceCount =
    params.proposal?.evidenceRefs.length ?? params.blockedProposal?.evidenceRefs.length;

  return {
    policyReasons,
    missingEvidence: getAoiMissingEvidenceLabels(rawReasons, evidenceCount),
    safeAlternative: sanitizeAoiProposalDisplayText(
      params.blockedProposal?.safeAlternative ??
        getAoiSafeAlternativeForReasons(proposalForAlternative, rawReasons),
      220,
    ),
  };
}

function getAoiMissionVisibleState(
  mission: AoiMissionState | null | undefined,
): AoiAutonomyVisibleState | null {
  if (!mission || mission.status === 'none') {
    return null;
  }
  if (mission.status === 'paused') {
    return 'paused';
  }
  if (mission.status === 'blocked') {
    return 'blocked';
  }
  if (mission.status === 'completed') {
    return 'completed';
  }
  if (mission.status === 'waiting_on_kira' || mission.sourceRefs.kiraWorkRef) {
    return 'delegated_to_kira';
  }
  if (mission.status === 'waiting_on_research') {
    return 'waiting_on_research';
  }
  if (mission.status === 'waiting_on_user') {
    return 'waiting_on_user';
  }
  return 'waiting_for_approval';
}

export function buildAoiProposalActionPresentation(
  proposal: AoiProposal,
  options: { hasKiraPreview?: boolean } = {},
): AoiProposalActionPresentation {
  const kind = proposal.acceptAction?.kind;
  if (proposal.status === 'blocked' || proposal.blockedReason) {
    return {
      visibleState: 'blocked',
      primaryLabel: 'Show evidence',
      primaryTitle: 'Show policy reasons, missing evidence, and a safe alternative.',
      primaryRole: 'none',
      mutationBoundary: 'No mutation is available while this proposal is blocked.',
      requiresPreviewBeforeFinal: kind === 'create_kira_work',
      finalActionAvailable: false,
    };
  }

  if (proposal.status === 'executed') {
    return {
      visibleState: kind === 'create_kira_work' ? 'delegated_to_kira' : 'completed',
      primaryLabel: 'Show evidence',
      primaryTitle: 'Show evidence for the completed action.',
      primaryRole: 'none',
      mutationBoundary: 'No additional mutation is available from this completed proposal.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: false,
    };
  }

  if (proposal.status === 'active') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve exact action',
      primaryTitle:
        'Record approval for this exact proposal. No tools run and no files are edited.',
      primaryRole: 'approve',
      mutationBoundary: 'Records approval only. It does not run tools or edit files.',
      requiresPreviewBeforeFinal: kind === 'create_kira_work',
      finalActionAvailable: false,
    };
  }

  if (proposal.status !== 'accepted') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Show evidence',
      primaryTitle: `No primary action is available while status is ${proposal.status}.`,
      primaryRole: 'none',
      mutationBoundary: 'No mutation is available for this proposal state.',
      requiresPreviewBeforeFinal: kind === 'create_kira_work',
      finalActionAvailable: false,
    };
  }

  if (kind === 'create_kira_work') {
    if (!options.hasKiraPreview) {
      return {
        visibleState: 'preview_ready',
        primaryLabel: 'Preview plan',
        primaryTitle:
          'Preview the Kira work item plan. This does not create work items or edit files.',
        primaryRole: 'preview',
        mutationBoundary: 'No mutation. It only previews the Kira work item plan.',
        requiresPreviewBeforeFinal: true,
        finalActionAvailable: false,
      };
    }

    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and create Kira work item',
      primaryTitle: 'Approve and create a reviewed Kira work item. This does not edit files.',
      primaryRole: 'execute',
      mutationBoundary: 'Creates one reviewed Kira work item only. It does not edit files.',
      requiresPreviewBeforeFinal: true,
      finalActionAvailable: true,
    };
  }

  if (kind === 'start_research') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and start research run',
      primaryTitle: 'Approve and start a new Aoi research run.',
      primaryRole: 'execute',
      mutationBoundary: 'Starts one Aoi research run.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'save_memory') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and promote memory',
      primaryTitle:
        'Approve memory promotion. This may promote memory or create an untrusted skill draft.',
      primaryRole: 'execute',
      mutationBoundary: 'Promotes memory or creates an untrusted skill draft.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'run_command') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and run validation command',
      primaryTitle:
        'Approve this exact validation command, cwd, purpose, and risk for one execution.',
      primaryRole: 'execute',
      mutationBoundary:
        'Runs one allowlisted validation or inspection command. It is not a general terminal.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'get_research_status') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Check research status',
      primaryTitle: 'Check linked research status without editing files.',
      primaryRole: 'execute',
      mutationBoundary: 'Reads research status only.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'open_research_artifact') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Open research artifact',
      primaryTitle: 'Open the approved research artifact without editing files.',
      primaryRole: 'execute',
      mutationBoundary: 'Opens an existing research artifact only.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'read_research_artifact') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Read research artifact',
      primaryTitle: 'Read the approved research artifact without editing files.',
      primaryRole: 'execute',
      mutationBoundary: 'Reads an existing research artifact only.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'open_app') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Review app handoff',
      primaryTitle: 'Review the approved app handoff. No direct app launch is available here.',
      primaryRole: 'none',
      mutationBoundary: 'No app is opened from this proposal card.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: false,
    };
  }

  if (kind === 'activate_goal') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Review goal activation',
      primaryTitle: 'Review the approved goal activation. Use goal controls to mutate goal state.',
      primaryRole: 'none',
      mutationBoundary: 'No goal state changes from this proposal card.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: false,
    };
  }

  return {
    visibleState: 'waiting_for_approval',
    primaryLabel: 'Review action',
    primaryTitle: 'Review the proposal details before any further action.',
    primaryRole: 'none',
    mutationBoundary: 'No direct mutation is available for this proposal action.',
    requiresPreviewBeforeFinal: false,
    finalActionAvailable: false,
  };
}

function formatPreparedActionLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

export function buildAoiPreparedActionPlanPanelSummary(
  plan: AoiPreparedActionPlan | null | undefined,
  includeDetails = false,
): AoiPreparedActionPlanPanelSummary {
  if (!plan) {
    return {
      visible: false,
      statusLabel: 'No prepared action plan',
      actionKindLabel: 'none',
      objective: '',
      riskLabel: '',
      approvalLabel: '',
      checkpointLabel: '',
      validationLabel: '',
      rollbackLabel: '',
      expectedChanges: [],
      affectedSurfaces: [],
      validationCommands: [],
      rollbackInstructions: [],
      blockers: [],
      nonGoals: [],
      evidenceRefs: [],
    };
  }

  const approvalLabel = plan.approval.required
    ? `approval required at ${plan.approval.requiredLevel}${plan.approval.freshAcceptanceRequired ? ', fresh acceptance' : ''}`
    : 'no approval required';
  const checkpointLabel = `${formatPreparedActionLabel(plan.checkpoint.kind)}: ${
    plan.checkpoint.available ? 'available' : 'missing'
  }`;
  const validationLabel = plan.validation.required
    ? `${plan.validation.commands.length} command(s), ${
        plan.validation.approvalRequiredBeforeRun ? 'approval before run' : 'read-only'
      }`
    : 'no validation command required';
  const rollbackLabel = `${formatPreparedActionLabel(plan.rollback.kind)}; guarantee=${
    plan.rollback.guarantee
  }`;

  return {
    visible: true,
    statusLabel: plan.status,
    actionKindLabel: sanitizeAoiProposalDisplayText(formatPreparedActionLabel(plan.actionKind), 80),
    objective: sanitizeAoiProposalDisplayText(plan.objective, 220),
    riskLabel: `${plan.risk.level} risk${
      plan.risk.mutationCapable ? ', mutation capable' : ''
    }${plan.risk.commandCapable ? ', command capable' : ''}`,
    approvalLabel: sanitizeAoiProposalDisplayText(approvalLabel, 160),
    checkpointLabel: sanitizeAoiProposalDisplayText(checkpointLabel, 180),
    validationLabel: sanitizeAoiProposalDisplayText(validationLabel, 180),
    rollbackLabel: sanitizeAoiProposalDisplayText(rollbackLabel, 180),
    expectedChanges: includeDetails
      ? plan.expectedChanges.slice(0, 8).map((item) => sanitizeAoiProposalDisplayText(item, 180))
      : plan.expectedChanges.slice(0, 2).map((item) => sanitizeAoiProposalDisplayText(item, 140)),
    affectedSurfaces: includeDetails
      ? plan.affectedSurfaces.slice(0, 8).map((item) => sanitizeAoiProposalDisplayText(item, 120))
      : plan.affectedSurfaces.slice(0, 3).map((item) => sanitizeAoiProposalDisplayText(item, 96)),
    validationCommands: includeDetails
      ? plan.validation.commands
          .slice(0, 6)
          .map((item) => sanitizeAoiProposalDisplayText(item, 180))
      : plan.validation.commands
          .slice(0, 2)
          .map((item) => sanitizeAoiProposalDisplayText(item, 140)),
    rollbackInstructions: includeDetails
      ? plan.rollback.instructions
          .slice(0, 6)
          .map((item) => sanitizeAoiProposalDisplayText(item, 180))
      : plan.rollback.instructions
          .slice(0, 2)
          .map((item) => sanitizeAoiProposalDisplayText(item, 140)),
    blockers: plan.blockers.slice(0, 6).map((item) => sanitizeAoiProposalDisplayText(item, 140)),
    nonGoals: includeDetails
      ? plan.nonGoals.slice(0, 6).map((item) => sanitizeAoiProposalDisplayText(item, 160))
      : [],
    evidenceRefs: includeDetails
      ? plan.evidenceRefs.slice(0, 8).map((item) => sanitizeAoiProposalDisplayText(item, 180))
      : [],
  };
}

export function buildAoiApprovedCommandPanelSummary(params: {
  policy?: AoiApprovedCommandPolicy | null;
  result?: AoiApprovedCommandResult | null;
  includeDetails?: boolean;
}): AoiApprovedCommandPanelSummary {
  const policy = params.policy ?? undefined;
  const result = params.result ?? undefined;
  if (!policy && !result) {
    return {
      visible: false,
      statusLabel: 'No approved command',
      commandLabel: '',
      cwdLabel: '',
      riskLabel: '',
      reasonLabels: [],
      resultLabel: '',
      stdoutExcerpt: '',
      stderrExcerpt: '',
      outputTruncated: false,
      evidenceRefs: [],
    };
  }

  const command = result?.command ?? policy?.displayCommand ?? '';
  const cwdLabel = result?.cwdLabel ?? policy?.cwdLabel ?? 'workspace root';
  const resultLabel = result
    ? `exit ${result.exitCode ?? 'unknown'} in ${result.durationMs}ms${
        result.timedOut ? ', timed out' : ''
      }`
    : policy?.allowed
      ? 'ready for exact approval'
      : 'blocked before approval';
  const reasonLabels = policy
    ? policy.allowed
      ? policy.rationale
      : policy.blockReasons.map((reason) => `blocked:${formatPreparedActionLabel(reason)}`)
    : [];
  const evidenceRefs = [
    ...new Set([
      ...(policy ? [`command-approval:${policy.approvalFingerprint}`] : []),
      ...(result?.evidenceRefs ?? []),
    ]),
  ];

  return {
    visible: true,
    statusLabel: result
      ? result.ok
        ? 'passed'
        : result.timedOut
          ? 'timed out'
          : 'failed'
      : policy?.allowed
        ? 'approval required'
        : 'blocked',
    commandLabel: sanitizeAoiProposalDisplayText(command, 220),
    cwdLabel: sanitizeAoiProposalDisplayText(cwdLabel, 160),
    riskLabel: `${policy?.risk ?? result?.auditRecord.risk ?? 'high'} risk, L5 approval`,
    reasonLabels: (params.includeDetails ? reasonLabels.slice(0, 8) : reasonLabels.slice(0, 3)).map(
      (item) => sanitizeAoiProposalDisplayText(item, 180),
    ),
    resultLabel: sanitizeAoiProposalDisplayText(resultLabel, 180),
    stdoutExcerpt:
      params.includeDetails && result
        ? sanitizeAoiProposalDisplayText(result.stdoutExcerpt, 600)
        : '',
    stderrExcerpt:
      params.includeDetails && result
        ? sanitizeAoiProposalDisplayText(result.stderrExcerpt, 600)
        : '',
    outputTruncated: result?.stdoutTruncated === true || result?.stderrTruncated === true,
    evidenceRefs: params.includeDetails
      ? evidenceRefs.slice(0, 8).map((item) => sanitizeAoiProposalDisplayText(item, 180))
      : [],
  };
}

export function buildAoiPreferenceInfluencePanelSummary(params: {
  proposal?: AoiProposal | null;
  memories?: AoiMemoryEntry[] | null;
  projectKey?: string;
  includeDetails?: boolean;
  now?: number;
}): AoiPreferenceInfluencePanelSummary {
  const memories = params.memories ?? [];
  if (memories.length === 0) {
    return {
      visible: false,
      statusLabel: 'No preferences',
      preferenceLabels: [],
      conflictLabels: [],
      demotionLabels: [],
      sourceRefs: [],
      availableActions: ['save', 'demote', 'archive', 'mark_temporary'],
    };
  }
  const resolution = resolveAoiPreferenceContext({
    memories,
    projectKey: params.projectKey,
    now: params.now,
  });
  const proposalRefs = new Set([
    ...(params.proposal?.memoryIds.map((id) => `memory:${id}`) ?? []),
    ...(params.proposal?.evidenceRefs ?? []),
    ...(params.proposal?.artifactRefs ?? []),
  ]);
  const influenced =
    proposalRefs.size > 0
      ? resolution.active.filter(
          (item) =>
            proposalRefs.has(item.ref) || item.sourceRefs.some((ref) => proposalRefs.has(ref)),
        )
      : resolution.active;
  const active = influenced.length > 0 ? influenced : resolution.active.slice(0, 3);
  if (
    active.length === 0 &&
    resolution.conflicts.length === 0 &&
    resolution.demotions.length === 0
  ) {
    return {
      visible: false,
      statusLabel: 'No preferences',
      preferenceLabels: [],
      conflictLabels: [],
      demotionLabels: [],
      sourceRefs: [],
      availableActions: ['save', 'demote', 'archive', 'mark_temporary'],
    };
  }
  const includeDetails = params.includeDetails === true;
  const preferenceLabels = active
    .slice(0, includeDetails ? 6 : 2)
    .map((item) =>
      sanitizeAoiProposalDisplayText(
        `${item.kind.replace(/_/g, ' ')} conf ${item.confidence.toFixed(2)}: ${item.text}`,
        includeDetails ? 220 : 140,
      ),
    );
  const conflictLabels = resolution.conflicts
    .slice(0, includeDetails ? 5 : 2)
    .map((conflict) => sanitizeAoiProposalDisplayText(conflict.explanation, 180));
  const demotionLabels = resolution.demotions
    .slice(0, includeDetails ? 5 : 1)
    .map((demotion) =>
      sanitizeAoiProposalDisplayText(
        `${demotion.memoryId} demoted: ${demotion.reason.replace(/_/g, ' ')}`,
        160,
      ),
    );
  const sourceRefs = includeDetails
    ? [
        ...new Set([
          ...active.flatMap((item) => item.sourceRefs),
          ...resolution.conflicts.flatMap((conflict) => conflict.evidenceRefs),
          ...resolution.demotions.flatMap((demotion) => demotion.evidenceRefs),
        ]),
      ]
        .slice(0, 8)
        .map((ref) => sanitizeAoiProposalDisplayText(ref, 180))
    : [];

  return {
    visible: true,
    statusLabel:
      resolution.conflicts.length > 0
        ? 'conflict resolved'
        : active.length > 0
          ? `${active.length} active`
          : 'demoted',
    preferenceLabels,
    conflictLabels,
    demotionLabels,
    sourceRefs,
    availableActions: ['save', 'demote', 'archive', 'mark_temporary'],
  };
}

export function buildAoiOperatorDigestPanelSummary(
  digest: AoiOperatorDigest | null | undefined,
  includeDetails = false,
): AoiOperatorDigestPanelSummary {
  if (!digest || (digest.items.length === 0 && digest.approvalInbox.length === 0)) {
    return {
      visible: false,
      summaryLabel: 'No ambient updates',
      laneLabels: [],
      itemLabels: [],
      approvalLabels: [],
      resumeBriefLabel: '',
      hiddenLabel: '',
      evidenceRefs: [],
    };
  }
  const laneLabels = (
    [
      ['critical_user_blocking', 'critical'],
      ['needs_approval', 'approval'],
      ['mission_update', 'mission'],
      ['fyi', 'fyi'],
      ['hidden_by_quiet_mode', 'hidden'],
    ] as const
  )
    .map(([lane, label]) => `${label} ${digest.laneCounts[lane]}`)
    .filter((label) => !label.endsWith(' 0'));
  const itemLabels = digest.items
    .filter((item) => includeDetails || !item.hidden)
    .slice(0, includeDetails ? 6 : 3)
    .map((item) =>
      sanitizeAoiProposalDisplayText(
        `${item.lane.replace(/_/g, ' ')}: ${item.title} - ${item.summary}`,
        includeDetails ? 260 : 160,
      ),
    );
  const approvalLabels = digest.approvalInbox
    .slice(0, includeDetails ? 5 : 2)
    .map((item) =>
      sanitizeAoiProposalDisplayText(
        `${item.title}: ${item.exactNextAction} (${item.risk}, evidence ${item.evidenceCount})`,
        includeDetails ? 240 : 150,
      ),
    );
  const resumeBriefLabel = digest.resumeBrief?.visible
    ? sanitizeAoiProposalDisplayText(
        `${digest.resumeBrief.whatChanged} Next: ${digest.resumeBrief.nextSafeAction} Boundary: ${digest.resumeBrief.safetyBoundary}`,
        260,
      )
    : '';
  const hiddenLabel =
    digest.hiddenItemCount > 0
      ? `${digest.hiddenItemCount} quiet update${digest.hiddenItemCount === 1 ? '' : 's'} hidden`
      : digest.quietWindow?.enabled
        ? 'Quiet mode active'
        : '';

  return {
    visible: true,
    summaryLabel: sanitizeAoiProposalDisplayText(digest.summary, 180),
    laneLabels,
    itemLabels,
    approvalLabels,
    resumeBriefLabel,
    hiddenLabel,
    evidenceRefs: includeDetails
      ? digest.evidenceRefs.slice(0, 10).map((ref) => sanitizeAoiProposalDisplayText(ref, 180))
      : [],
  };
}

function formatAoiAgendaAge(timestamp: number | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return 'not recorded';
  }
  const deltaMs = Math.max(0, now - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) {
    return 'just now';
  }
  if (deltaMs < hour) {
    return `${Math.max(1, Math.round(deltaMs / minute))}m ago`;
  }
  if (deltaMs < day) {
    return `${Math.max(1, Math.round(deltaMs / hour))}h ago`;
  }
  return `${Math.max(1, Math.round(deltaMs / day))}d ago`;
}

function sortAoiAgendaProposals(proposals: AoiProposal[]): AoiProposal[] {
  return [...proposals].sort((left, right) => {
    const statusDelta =
      (right.status === 'accepted' ? 1 : 0) - (left.status === 'accepted' ? 1 : 0);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const confidenceDelta = right.confidence - left.confidence;
    if (Math.abs(confidenceDelta) > 0.001) {
      return confidenceDelta;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function collectAoiAgendaEvidenceRefs(...groups: Array<readonly string[] | undefined>): string[] {
  const refs = new Set<string>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const sanitized = sanitizeAoiProposalDisplayText(ref, 180);
      if (sanitized) {
        refs.add(sanitized);
      }
      if (refs.size >= 12) {
        return [...refs];
      }
    }
  }
  return [...refs];
}

function getAoiAgendaActionLabel(proposal: AoiProposal | undefined): string {
  if (!proposal) {
    return 'No prepared action';
  }
  const actionKind = proposal.acceptAction?.kind ?? proposal.suggestedTools[0] ?? 'review';
  return `${actionKind.replace(/_/g, ' ')}: ${sanitizeAoiProposalDisplayText(proposal.title, 96)}`;
}

function buildAoiAgendaPhase(params: {
  key: AoiAutonomyAgendaPhaseKey;
  label: string;
  statusLabel: string;
  primaryLabel: string;
  detailLabels?: string[];
  evidenceRefs?: string[];
  tone: AoiAutonomyAgendaTone;
}): AoiAutonomyAgendaPhaseSummary {
  return {
    key: params.key,
    label: params.label,
    statusLabel: sanitizeAoiProposalDisplayText(params.statusLabel, 80),
    primaryLabel: sanitizeAoiProposalDisplayText(params.primaryLabel, 180),
    detailLabels: (params.detailLabels ?? [])
      .map((label) => sanitizeAoiProposalDisplayText(label, 180))
      .filter(Boolean)
      .slice(0, 4),
    evidenceRefs: (params.evidenceRefs ?? [])
      .map((ref) => sanitizeAoiProposalDisplayText(ref, 180))
      .filter(Boolean)
      .slice(0, 6),
    tone: params.tone,
  };
}

export function buildAoiAutonomyAgendaPanelSummary(params: {
  status?: AoiAutonomyStatus | null;
  activeProposals?: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  mission?: AoiMissionState | null;
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  digest?: AoiOperatorDigest | null;
  scheduler?: AoiAutonomySchedulerState | null;
  health?: AoiOperatorHealthState | null;
  recentDecisions?: AoiProposalDecision[];
  settings?: AoiAutonomyPanelSettings;
  now?: number;
  includeDetails?: boolean;
}): AoiAutonomyAgendaPanelSummary {
  const now = params.now ?? Date.now();
  const settings = params.settings ?? DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  const policy = params.status?.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const activeProposals = params.activeProposals ?? [];
  const blockedProposals = params.blockedProposals ?? [];
  const recentDecisions = params.recentDecisions ?? [];
  const proposalCandidates = sortAoiAgendaProposals(
    activeProposals.filter(
      (proposal) => proposal.status === 'active' || proposal.status === 'snoozed',
    ),
  );
  const topProposal = proposalCandidates[0];
  const acceptedProposal = sortAoiAgendaProposals(
    activeProposals.filter((proposal) => proposal.status === 'accepted'),
  )[0];
  const approvalInbox = params.digest?.approvalInbox ?? [];
  const feedbackDecisions = recentDecisions.filter((decision) => decision.feedbackCategory);
  const lastDecision = recentDecisions[0];
  const enabledSourceCount = params.status?.enabledEnvironmentSourceCount ?? 0;
  const totalSourceCount = params.status?.environmentSourceCount ?? 0;
  const activeObservationLabel =
    params.status && params.status.recentObservationCount > 0
      ? `${params.status.recentObservationCount} recent observation(s)`
      : params.status
        ? `${params.status.observationCount} total observation(s)`
        : 'observation state unavailable';
  const workspaceLabel = params.workspaceSnapshot
    ? `${params.workspaceSnapshot.workspaceLabel}: ${params.workspaceSnapshot.freshness}`
    : 'workspace snapshot not loaded';
  const missionLabel = params.mission?.focusSummary
    ? `mission: ${params.mission.focusSummary}`
    : 'mission not active';
  const observationTone: AoiAutonomyAgendaTone =
    !policy.enabled || settings.quietMode ? 'muted' : enabledSourceCount > 0 ? 'active' : 'idle';
  const thinkTone: AoiAutonomyAgendaTone = params.status?.activeTick
    ? 'active'
    : params.status?.lastReflectionAt
      ? 'ready'
      : 'idle';
  const proposeTone: AoiAutonomyAgendaTone =
    blockedProposals.length > 0 ? 'blocked' : proposalCandidates.length > 0 ? 'waiting' : 'idle';
  const actTone: AoiAutonomyAgendaTone = acceptedProposal
    ? 'ready'
    : approvalInbox.length > 0
      ? 'waiting'
      : 'idle';
  const reflectTone: AoiAutonomyAgendaTone =
    feedbackDecisions.length > 0 ? 'active' : lastDecision ? 'ready' : 'idle';

  const phases: AoiAutonomyAgendaPhaseSummary[] = [
    buildAoiAgendaPhase({
      key: 'observe',
      label: 'Observe',
      statusLabel: policy.enabled ? (settings.quietMode ? 'quiet' : 'watching') : 'disabled',
      primaryLabel: activeObservationLabel,
      detailLabels: [
        `${enabledSourceCount}/${totalSourceCount} environment source(s) enabled`,
        workspaceLabel,
        params.scheduler?.recentWakeups[0]
          ? `last wakeup ${formatAoiAgendaAge(params.scheduler.recentWakeups[0].completedAt, now)}`
          : 'no wakeup record',
      ],
      evidenceRefs: collectAoiAgendaEvidenceRefs(params.workspaceSnapshot?.evidenceRefs),
      tone: observationTone,
    }),
    buildAoiAgendaPhase({
      key: 'think',
      label: 'Think',
      statusLabel: params.status?.activeTick ? 'running' : 'standing by',
      primaryLabel: params.status?.lastReflectionAt
        ? `last reflection ${formatAoiAgendaAge(params.status.lastReflectionAt, now)}`
        : 'no persisted reflection yet',
      detailLabels: [
        `${params.status?.reflectionCount ?? 0} reflection(s)`,
        params.status?.lastTickReason ? `last tick: ${params.status.lastTickReason}` : '',
        missionLabel,
        params.digest?.summary ?? '',
      ],
      evidenceRefs: collectAoiAgendaEvidenceRefs(params.digest?.evidenceRefs),
      tone: thinkTone,
    }),
    buildAoiAgendaPhase({
      key: 'propose',
      label: 'Propose',
      statusLabel:
        blockedProposals.length > 0
          ? `${blockedProposals.length} blocked`
          : `${proposalCandidates.length} proposal(s)`,
      primaryLabel: topProposal
        ? sanitizeAoiProposalDisplayText(topProposal.title, 160)
        : blockedProposals[0]
          ? sanitizeAoiProposalDisplayText(blockedProposals[0].title, 160)
          : 'no active proposal',
      detailLabels: [
        topProposal ? `why: ${topProposal.reason}` : '',
        `${approvalInbox.length} approval inbox item(s)`,
        blockedProposals[0]?.safeAlternative ?? '',
      ],
      evidenceRefs: collectAoiAgendaEvidenceRefs(
        topProposal?.evidenceRefs,
        blockedProposals[0]?.evidenceRefs,
      ),
      tone: proposeTone,
    }),
    buildAoiAgendaPhase({
      key: 'act',
      label: 'Act',
      statusLabel: acceptedProposal ? 'ready' : approvalInbox.length > 0 ? 'approval' : 'idle',
      primaryLabel: acceptedProposal
        ? getAoiAgendaActionLabel(acceptedProposal)
        : approvalInbox[0]?.exactNextAction || 'wait for explicit approval',
      detailLabels: [
        acceptedProposal
          ? `requires ${acceptedProposal.requiredAutonomyLevel}, risk ${acceptedProposal.risk}`
          : '',
        approvalInbox[0]?.boundary ?? '',
        policy.previewMode ? 'preview mode active' : '',
      ],
      evidenceRefs: collectAoiAgendaEvidenceRefs(
        acceptedProposal?.evidenceRefs,
        approvalInbox[0]?.evidenceRefs,
      ),
      tone: actTone,
    }),
    buildAoiAgendaPhase({
      key: 'reflect',
      label: 'Reflect',
      statusLabel: `${feedbackDecisions.length} feedback`,
      primaryLabel: lastDecision
        ? `last decision ${lastDecision.action} ${formatAoiAgendaAge(lastDecision.createdAt, now)}`
        : 'no recent decision',
      detailLabels: [
        feedbackDecisions[0]?.feedbackCategory
          ? `latest feedback: ${feedbackDecisions[0].feedbackCategory.replace(/_/g, ' ')}`
          : '',
        params.health ? `health: ${params.health.overallStatus.replace(/_/g, ' ')}` : '',
      ],
      evidenceRefs: collectAoiAgendaEvidenceRefs(
        lastDecision?.evidenceRefs,
        params.health?.evidenceRefs,
      ),
      tone: reflectTone,
    }),
  ];

  const headlineLabel = !policy.enabled
    ? 'Aoi autonomy is disabled'
    : settings.quietMode
      ? 'Aoi is observing quietly'
      : acceptedProposal
        ? 'Aoi has an accepted action ready'
        : approvalInbox.length > 0
          ? 'Aoi has approval-gated actions waiting'
          : topProposal
            ? 'Aoi has a proposal for you'
            : blockedProposals.length > 0
              ? 'Aoi found work but safety gates blocked it'
              : 'Aoi is observing and thinking in the background';
  const nextBestActionLabel = acceptedProposal
    ? `Execute or preview: ${getAoiAgendaActionLabel(acceptedProposal)}`
    : approvalInbox[0]
      ? `Review approval: ${sanitizeAoiProposalDisplayText(approvalInbox[0].exactNextAction, 140)}`
      : topProposal
        ? `Review proposal: ${sanitizeAoiProposalDisplayText(topProposal.title, 140)}`
        : blockedProposals[0]
          ? `Resolve gate: ${sanitizeAoiProposalDisplayText(
              blockedProposals[0].safeAlternative ?? blockedProposals[0].reasons.join(', '),
              140,
            )}`
          : 'Run check when you want a fresh autonomy pass';
  const safetyBoundaryLabel = acceptedProposal
    ? `Boundary: ${acceptedProposal.acceptAction?.kind ?? 'manual review'} stays behind ${acceptedProposal.requiredAutonomyLevel} and existing approval gates.`
    : approvalInbox[0]?.boundary ||
      'Boundary: no file writes, commands, commits, or external actions execute without the existing proposal gates.';
  const approvalInboxLabel =
    approvalInbox.length > 0
      ? `${approvalInbox.length} approval-gated action${approvalInbox.length === 1 ? '' : 's'} waiting`
      : blockedProposals.length > 0
        ? `${blockedProposals.length} blocked proposal${blockedProposals.length === 1 ? '' : 's'}`
        : 'No approval inbox pressure';

  return {
    visible: true,
    headlineLabel: sanitizeAoiProposalDisplayText(headlineLabel, 180),
    loopLabel: 'Observe -> Think -> Propose -> Act -> Reflect',
    nextBestActionLabel: sanitizeAoiProposalDisplayText(nextBestActionLabel, 200),
    safetyBoundaryLabel: sanitizeAoiProposalDisplayText(safetyBoundaryLabel, 240),
    approvalInboxLabel,
    phaseSummaries: params.includeDetails
      ? phases
      : phases.map((phase) => ({
          ...phase,
          detailLabels: phase.detailLabels.slice(0, 2),
          evidenceRefs: phase.evidenceRefs.slice(0, 3),
        })),
    evidenceRefs: collectAoiAgendaEvidenceRefs(
      params.digest?.evidenceRefs,
      topProposal?.evidenceRefs,
      acceptedProposal?.evidenceRefs,
      blockedProposals[0]?.evidenceRefs,
      params.workspaceSnapshot?.evidenceRefs,
    ),
  };
}

function buildAoiAgendaChatNudgeText(params: {
  title: string;
  whyNow: string;
  safeNextAction: string;
  boundary?: string;
  evidenceRefs?: readonly string[];
}): string {
  const evidenceCount = params.evidenceRefs?.length ?? 0;
  const evidenceLabel =
    evidenceCount > 0
      ? `${evidenceCount} evidence ref${evidenceCount === 1 ? '' : 's'} attached in the Aoi panel.`
      : 'No evidence refs are attached yet, so keep this as review-only.';
  const boundary =
    params.boundary ||
    'I am only surfacing this signal; no tools, app actions, file changes, commits, or pushes start from this nudge.';

  return [
    `Aoi agenda update: ${sanitizeAoiProposalDisplayText(params.title, 140)}.`,
    `Why now: ${sanitizeAoiProposalDisplayText(params.whyNow, 220)}`,
    `Safe next step: ${sanitizeAoiProposalDisplayText(params.safeNextAction, 220)}`,
    `Boundary: ${sanitizeAoiProposalDisplayText(boundary, 260)}`,
    `Evidence: ${evidenceLabel}`,
  ].join('\n');
}

function buildAoiAgendaSuggestedReplies(reason: AoiAgendaChatNudgeReason): string[] {
  if (reason === 'accepted_action_ready') {
    return ['Preview the prepared action', 'Show the safety boundary', 'Keep observing quietly'];
  }
  if (reason === 'approval_waiting') {
    return ['Review the approval gate', 'Explain why now', 'Keep observing quietly'];
  }
  if (reason === 'blocked_gate') {
    return ['Explain the blocked gate', 'Show the safe alternative', 'Keep observing quietly'];
  }
  return ['Explain why this matters', 'Show the safe next step', 'Keep observing quietly'];
}

export function selectAoiAgendaChatNudge(params: {
  status?: AoiAutonomyStatus | null;
  activeProposals?: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  digest?: AoiOperatorDigest | null;
  settings?: AoiAutonomyPanelSettings;
  options?: AoiAgendaChatNudgeSelectionOptions;
}): AoiAgendaChatNudge | null {
  const status = params.status;
  const settings = params.settings ?? DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  const options = params.options ?? {};
  const policy = status?.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;

  if (!status || status.activeTick) {
    return null;
  }
  if (!policy.enabled || !policy.proactiveSuggestionsEnabled) {
    return null;
  }
  if (options.quietMode ?? settings.quietMode) {
    return null;
  }
  if (!(options.notificationsEnabled ?? settings.notificationsEnabled)) {
    return null;
  }

  const now = options.now ?? Date.now();
  const calibrationGate = getAoiAgendaNudgeCalibrationGate(
    options.calibration ?? settings.agendaNudgeCalibration,
    now,
  );
  if (calibrationGate.suppressed) {
    return null;
  }

  const maxPerSession = options.maxPerSession ?? settings.maxSuggestionsPerSession;
  const shownCount = options.shownCount ?? 0;
  if (maxPerSession <= 0 || shownCount >= maxPerSession) {
    return null;
  }

  const cooldownMs = options.cooldownMs ?? AOI_AGENDA_CHAT_NUDGE_COOLDOWN_MS;
  if (
    typeof options.lastShownAt === 'number' &&
    options.lastShownAt > 0 &&
    now - options.lastShownAt < cooldownMs
  ) {
    return null;
  }

  const activeProposals = params.activeProposals ?? [];
  const blockedProposals = params.blockedProposals ?? [];
  const approvalInbox = params.digest?.approvalInbox ?? [];
  const acceptedProposal = sortAoiAgendaProposals(
    activeProposals.filter((proposal) => proposal.status === 'accepted'),
  )[0];
  const topApproval = approvalInbox[0];
  const topBlockedProposal = blockedProposals[0];
  const highSignalProposal = sortAoiAgendaProposals(
    activeProposals.filter((proposal) => {
      if (!isAoiProposalInlineEligible(proposal, { now })) {
        return false;
      }
      if (proposal.risk === 'high') {
        return false;
      }
      return (
        proposal.confidence >= 0.78 ||
        proposal.evidenceRefs.length >= 3 ||
        proposal.requiresUserApproval
      );
    }),
  )[0];

  let nudge: AoiAgendaChatNudge | null = null;
  if (acceptedProposal) {
    const evidenceRefs = collectAoiAgendaEvidenceRefs(acceptedProposal.evidenceRefs);
    nudge = {
      dedupeKey: `accepted:${acceptedProposal.id}`,
      reason: 'accepted_action_ready',
      proposalId: acceptedProposal.id,
      chatText: buildAoiAgendaChatNudgeText({
        title: 'An accepted action is ready for review',
        whyNow: acceptedProposal.reason,
        safeNextAction: `Preview or confirm ${getAoiAgendaActionLabel(acceptedProposal)} from the Aoi panel.`,
        boundary: `${acceptedProposal.acceptAction?.kind ?? 'prepared action'} remains behind ${acceptedProposal.requiredAutonomyLevel} and the existing approval controls.`,
        evidenceRefs,
      }),
      suggestedReplies: buildAoiAgendaSuggestedReplies('accepted_action_ready'),
      evidenceRefs,
    };
  } else if (topApproval) {
    const evidenceRefs = collectAoiAgendaEvidenceRefs(topApproval.evidenceRefs);
    nudge = {
      dedupeKey: `approval:${topApproval.dedupeKey || topApproval.proposalId}`,
      reason: 'approval_waiting',
      proposalId: topApproval.proposalId,
      chatText: buildAoiAgendaChatNudgeText({
        title: 'An approval-gated action is waiting',
        whyNow: topApproval.title,
        safeNextAction: topApproval.exactNextAction,
        boundary: topApproval.boundary,
        evidenceRefs,
      }),
      suggestedReplies: buildAoiAgendaSuggestedReplies('approval_waiting'),
      evidenceRefs,
    };
  } else if (topBlockedProposal) {
    const evidenceRefs = collectAoiAgendaEvidenceRefs(topBlockedProposal.evidenceRefs);
    nudge = {
      dedupeKey: `blocked:${topBlockedProposal.proposalId}`,
      reason: 'blocked_gate',
      proposalId: topBlockedProposal.proposalId,
      chatText: buildAoiAgendaChatNudgeText({
        title: 'A safety gate blocked proposed work',
        whyNow:
          topBlockedProposal.reasons.length > 0
            ? topBlockedProposal.reasons.join(', ')
            : topBlockedProposal.title,
        safeNextAction:
          topBlockedProposal.safeAlternative ||
          'Review the blocked proposal in the Aoi panel before taking any action.',
        evidenceRefs,
      }),
      suggestedReplies: buildAoiAgendaSuggestedReplies('blocked_gate'),
      evidenceRefs,
    };
  } else if (highSignalProposal) {
    const evidenceRefs = collectAoiAgendaEvidenceRefs(highSignalProposal.evidenceRefs);
    nudge = {
      dedupeKey: `proposal:${highSignalProposal.id}`,
      reason: 'high_signal_proposal',
      proposalId: highSignalProposal.id,
      chatText: buildAoiAgendaChatNudgeText({
        title: 'A high-signal proposal is ready',
        whyNow: highSignalProposal.reason,
        safeNextAction: `Review proposal: ${sanitizeAoiProposalDisplayText(highSignalProposal.title, 140)}.`,
        evidenceRefs,
      }),
      suggestedReplies: buildAoiAgendaSuggestedReplies('high_signal_proposal'),
      evidenceRefs,
    };
  }

  if (!nudge || options.shownDedupeKeys?.has(nudge.dedupeKey)) {
    return null;
  }

  return nudge;
}

function getAoiAgendaNudgeReasonLabel(reason: AoiAgendaChatNudgeReason): string {
  if (reason === 'accepted_action_ready') {
    return 'accepted action ready';
  }
  if (reason === 'approval_waiting') {
    return 'approval waiting';
  }
  if (reason === 'blocked_gate') {
    return 'blocked gate';
  }
  return 'high-signal proposal';
}

function formatAoiAgendaNudgeWait(waitMs: number): string {
  if (waitMs <= 60 * 1000) {
    return 'less than 1 minute';
  }
  const minutes = Math.ceil(waitMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function buildAoiAgendaNudgeReadinessAuditLabels(
  audit: AoiAgendaNudgeReadinessActionAudit | null | undefined,
): string[] {
  const normalized = normalizeAoiAgendaNudgeReadinessActionAudit(audit);
  if (!normalized) {
    return [];
  }

  return [
    `Last recovery: ${normalized.actionLabel} while ${normalized.statusBefore}.`,
    `Candidate then: ${normalized.candidateBefore}.`,
    `Boundary: ${normalized.safetyBoundary}`,
    `Recorded: ${new Date(normalized.recordedAt).toLocaleString()}.`,
  ];
}

function buildAoiAgendaNudgeDeliveryDecisionLabels(params: {
  state: 'ready' | 'silent' | 'blocked';
  reason: string;
  now: number;
  nextEligibleAt?: number | null;
  nextEligibleReason?: string;
}): string[] {
  const prefix =
    params.state === 'ready'
      ? 'Delivery: ready to speak.'
      : params.state === 'silent'
        ? 'Delivery: silent.'
        : 'Delivery: blocked.';
  const labels = [`${prefix} ${sanitizeAoiProposalDisplayText(params.reason, 180)}`];

  if (params.state === 'ready') {
    labels.push('Next eligible: now.');
  } else if (
    typeof params.nextEligibleAt === 'number' &&
    Number.isFinite(params.nextEligibleAt) &&
    params.nextEligibleAt > params.now
  ) {
    labels.push(
      `Next eligible: ${formatAoiAgendaNudgeWait(
        params.nextEligibleAt - params.now,
      )} (${new Date(params.nextEligibleAt).toLocaleString()}).`,
    );
  } else {
    labels.push(
      `Next eligible: ${
        params.nextEligibleReason ||
        'waits for a new qualifying agenda item or an operator settings change.'
      }`,
    );
  }

  labels.push(
    'Boundary: direct agenda delivery only; no tools, app actions, policy bypass, or execution gates run from this decision.',
  );
  return labels;
}

function buildAoiAgendaNudgeLastDecisionLabels(
  audit: AoiAgendaNudgeDeliveryDecisionAudit | null | undefined,
): string[] {
  const normalized = normalizeAoiAgendaNudgeDeliveryDecisionAudit(audit);
  if (!normalized) {
    return [];
  }

  return [
    `Last decision: ${normalized.state} while ${normalized.statusLabel}.`,
    `Decision candidate: ${normalized.candidateLabel}.`,
    `Decision summary: ${normalized.summaryLabel}`,
    ...normalized.decisionLabels.slice(0, 3).map((label) => `Decision detail: ${label}`),
    `Decision boundary: ${normalized.safetyBoundary}`,
    `Decision recorded: ${new Date(normalized.recordedAt).toLocaleString()}.`,
  ];
}

function buildAoiAgendaNudgeDecisionFeedbackActions(
  audit: AoiAgendaNudgeDeliveryDecisionAudit | null | undefined,
  feedbackAudit: AoiAgendaNudgeDecisionFeedbackAudit | null | undefined,
): AoiAgendaNudgeDecisionFeedbackAction[] {
  const normalized = normalizeAoiAgendaNudgeDeliveryDecisionAudit(audit);
  if (!normalized) {
    return [];
  }
  const normalizedFeedback = normalizeAoiAgendaNudgeDecisionFeedbackAudit(feedbackAudit);

  const stateLabel = `${normalized.state}/${normalized.statusLabel}`;
  const reason = `delivery decision ${stateLabel}`;
  const dedupeKey = sanitizeAoiProposalDisplayText(
    `agenda-decision:${normalized.state}:${normalized.recordedAt}:${normalized.statusLabel}`,
    160,
  );

  const buildAction = (
    action: Omit<AoiAgendaNudgeDecisionFeedbackAction, 'reason' | 'dedupeKey' | 'disabled'>,
  ): AoiAgendaNudgeDecisionFeedbackAction => ({
    ...action,
    reason,
    dedupeKey,
    disabled:
      normalizedFeedback?.actionId === action.id && normalizedFeedback.dedupeKey === dedupeKey,
  });

  return [
    buildAction({
      id: 'mark_decision_useful',
      kind: 'useful',
      label: 'Useful',
      title: 'Record that this delivery decision was useful and clear local nudge mute state',
    }),
    buildAction({
      id: 'mark_decision_too_much',
      kind: 'too_much',
      label: 'Too much',
      title: 'Record that this delivery decision was too noisy and temporarily mute nudges',
    }),
    buildAction({
      id: 'quiet_decision_nudges',
      kind: 'quieted',
      label: 'Quiet for now',
      title: 'Record that Aoi should stay quieter for this delivery decision class',
    }),
  ];
}

function buildAoiAgendaNudgeLastDecisionFeedbackLabels(
  audit: AoiAgendaNudgeDecisionFeedbackAudit | null | undefined,
): string[] {
  const normalized = normalizeAoiAgendaNudgeDecisionFeedbackAudit(audit);
  if (!normalized) {
    return [];
  }

  return [
    `Last feedback: ${normalized.actionLabel} (${normalized.kind.replace(/_/g, ' ')}).`,
    `Feedback reason: ${normalized.reason}.`,
    `Feedback dedupe: ${normalized.dedupeKey}.`,
    `Feedback boundary: ${normalized.safetyBoundary}`,
    `Feedback recorded: ${new Date(normalized.recordedAt).toLocaleString()}.`,
  ];
}

function buildAoiAgendaNudgeDecisionFeedbackHistoryLabels(
  history: AoiAgendaNudgeDecisionFeedbackAudit[] | null | undefined,
): string[] {
  const normalized = normalizeAoiAgendaNudgeDecisionFeedbackHistory(history);
  if (normalized.length === 0) {
    return [];
  }

  return [
    `Feedback trail: ${normalized.length} recent calibration event(s).`,
    ...normalized.slice(0, 3).map((audit, index) => {
      const kindLabel = audit.kind.replace(/_/g, ' ');
      return `Feedback trail ${index + 1}: ${audit.actionLabel} (${kindLabel}) for ${audit.reason} at ${new Date(audit.recordedAt).toLocaleString()}.`;
    }),
  ];
}

export function buildAoiAgendaNudgeDecisionFeedbackAudit(params: {
  action: AoiAgendaNudgeDecisionFeedbackAction;
  now?: number;
}): AoiAgendaNudgeDecisionFeedbackAudit {
  return {
    version: 1,
    actionId: params.action.id,
    kind: params.action.kind,
    actionLabel: sanitizeAoiProposalDisplayText(params.action.label, 120),
    reason: sanitizeAoiProposalDisplayText(params.action.reason, 160),
    dedupeKey: sanitizeAoiProposalDisplayText(params.action.dedupeKey, 160),
    recordedAt: Math.round(params.now ?? Date.now()),
    safetyBoundary:
      'Local delivery feedback only; no tools, app actions, policy bypass, or execution gates were run.',
  };
}

export function buildAoiAgendaNudgeDeliveryDecisionAudit(params: {
  summary: Pick<
    AoiAgendaNudgeReadinessPanelSummary,
    | 'tone'
    | 'statusLabel'
    | 'candidateLabel'
    | 'summaryLabel'
    | 'deliveryDecisionLabels'
    | 'evidenceRefs'
  >;
  now?: number;
}): AoiAgendaNudgeDeliveryDecisionAudit {
  const state: AoiAgendaNudgeDeliveryDecisionState =
    params.summary.tone === 'ready'
      ? 'ready'
      : params.summary.tone === 'blocked'
        ? 'blocked'
        : 'silent';

  return {
    version: 1,
    recordedAt: Math.round(params.now ?? Date.now()),
    state,
    statusLabel: sanitizeAoiProposalDisplayText(params.summary.statusLabel, 120),
    candidateLabel: sanitizeAoiProposalDisplayText(params.summary.candidateLabel, 180),
    summaryLabel: sanitizeAoiProposalDisplayText(params.summary.summaryLabel, 220),
    decisionLabels: params.summary.deliveryDecisionLabels
      .slice(0, 6)
      .map((label) => sanitizeAoiProposalDisplayText(label, 260)),
    evidenceRefs: params.summary.evidenceRefs
      .slice(0, 8)
      .map((ref) => sanitizeAoiProposalDisplayText(ref, 180)),
    safetyBoundary:
      'Local delivery decision audit only; no tools, app actions, policy bypass, or execution gates were run.',
  };
}

export function buildAoiAgendaNudgeReadinessActionAudit(params: {
  action: AoiAgendaNudgeReadinessAction;
  summary: Pick<AoiAgendaNudgeReadinessPanelSummary, 'statusLabel' | 'candidateLabel'>;
  now?: number;
}): AoiAgendaNudgeReadinessActionAudit {
  return {
    version: 1,
    actionId: params.action.id,
    actionLabel: sanitizeAoiProposalDisplayText(params.action.label, 120),
    recordedAt: Math.round(params.now ?? Date.now()),
    statusBefore: sanitizeAoiProposalDisplayText(params.summary.statusLabel, 120),
    candidateBefore: sanitizeAoiProposalDisplayText(params.summary.candidateLabel, 180),
    safetyBoundary:
      'Local readiness recovery only; no tools, app actions, policy bypass, or execution gates were run.',
  };
}

export function buildAoiAgendaNudgeReadinessPanelSummary(params: {
  status?: AoiAutonomyStatus | null;
  activeProposals?: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  digest?: AoiOperatorDigest | null;
  settings?: AoiAutonomyPanelSettings;
  options?: AoiAgendaChatNudgeSelectionOptions;
}): AoiAgendaNudgeReadinessPanelSummary {
  const status = params.status;
  const settings = params.settings ?? DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  const options = params.options ?? {};
  const policy = status?.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const now = options.now ?? Date.now();
  const activeProposals = params.activeProposals ?? [];
  const blockedProposals = params.blockedProposals ?? [];
  const approvalCount = params.digest?.approvalInbox.length ?? 0;
  const summaryCountLabel = `${activeProposals.length} active, ${blockedProposals.length} blocked, ${approvalCount} approval`;
  const lastActionLabels = buildAoiAgendaNudgeReadinessAuditLabels(
    settings.agendaNudgeReadinessLastAction,
  );
  const lastDecisionLabels = buildAoiAgendaNudgeLastDecisionLabels(
    settings.agendaNudgeReadinessLastDecision,
  );
  const lastDecisionFeedbackLabels = buildAoiAgendaNudgeLastDecisionFeedbackLabels(
    settings.agendaNudgeReadinessLastDecisionFeedback,
  );
  const decisionFeedbackHistoryLabels = buildAoiAgendaNudgeDecisionFeedbackHistoryLabels(
    settings.agendaNudgeReadinessDecisionFeedbackHistory,
  );
  const decisionFeedbackActions = buildAoiAgendaNudgeDecisionFeedbackActions(
    settings.agendaNudgeReadinessLastDecision,
    settings.agendaNudgeReadinessLastDecisionFeedback,
  );

  const blockedSummary = (
    statusLabel: string,
    summaryLabel: string,
    reasonLabels: string[],
    nextActionLabels: string[],
    evidenceRefs: string[] = [],
    actions: AoiAgendaNudgeReadinessAction[] = [],
    deliveryReason = summaryLabel,
  ): AoiAgendaNudgeReadinessPanelSummary => ({
    visible: true,
    statusLabel,
    summaryLabel,
    candidateLabel: summaryCountLabel,
    deliveryDecisionLabels: buildAoiAgendaNudgeDeliveryDecisionLabels({
      state: 'blocked',
      reason: deliveryReason,
      now,
      nextEligibleReason: 'waits for the blocking setting or policy gate to change.',
    }),
    reasonLabels,
    nextActionLabels,
    actions,
    lastActionLabels,
    lastDecisionLabels,
    lastDecisionFeedbackLabels,
    decisionFeedbackHistoryLabels,
    decisionFeedbackActions,
    evidenceRefs,
    tone: 'blocked',
  });

  if (!status) {
    return blockedSummary(
      'unavailable',
      'Aoi has no autonomy status snapshot for direct agenda nudges yet.',
      ['Autonomy status has not loaded.'],
      ['Refresh Aoi autonomy status before expecting a direct agenda chat nudge.'],
      [],
      [
        {
          id: 'refresh_autonomy',
          label: 'Refresh',
          title: 'Refresh Aoi autonomy state before checking agenda nudge readiness',
        },
      ],
    );
  }

  if (status.activeTick) {
    return blockedSummary(
      'busy',
      'Aoi is already processing an autonomy tick.',
      ['Direct agenda nudges wait while an active tick is running.'],
      ['Let the current tick finish before Aoi speaks proactively.'],
      [],
      [
        {
          id: 'refresh_autonomy',
          label: 'Refresh',
          title: 'Refresh Aoi autonomy state after the active tick finishes',
        },
      ],
    );
  }

  if (!policy.enabled) {
    return blockedSummary(
      'policy off',
      'Aoi autonomy policy is disabled.',
      ['The global autonomy policy blocks direct agenda nudges.'],
      ['Enable Aoi autonomy before expecting proactive agenda chat.'],
    );
  }

  if (!policy.proactiveSuggestionsEnabled) {
    return blockedSummary(
      'suggestions off',
      'Aoi proactive suggestions are disabled by policy.',
      ['The proactive suggestion policy blocks agenda chat nudges.'],
      ['Enable proactive suggestions in Aoi settings.'],
    );
  }

  if (options.quietMode ?? settings.quietMode) {
    return blockedSummary(
      'quiet mode',
      'Aoi agenda nudges are paused by panel quiet mode.',
      ['Quiet mode blocks direct agenda chat nudges but keeps observation active.'],
      ['Turn off quiet mode when you want Aoi to speak proactively again.'],
      [],
      [
        {
          id: 'disable_quiet_mode',
          label: 'Leave quiet mode',
          title: 'Turn off only the local Aoi panel quiet mode',
        },
      ],
    );
  }

  if (!(options.notificationsEnabled ?? settings.notificationsEnabled)) {
    return blockedSummary(
      'notifications off',
      'Aoi agenda nudges are waiting for notification permission.',
      ['Panel notifications are off, so direct agenda chat nudges stay silent.'],
      ['Turn on Aoi panel notifications to allow compact direct chat nudges.'],
      [],
      [
        {
          id: 'enable_notifications',
          label: 'Enable notifications',
          title: 'Allow Aoi to show compact direct agenda chat nudges in this panel',
        },
      ],
    );
  }

  const calibrationGate = getAoiAgendaNudgeCalibrationGate(
    options.calibration ?? settings.agendaNudgeCalibration,
    now,
  );
  if (calibrationGate.suppressed) {
    return blockedSummary(
      'muted',
      'Aoi agenda nudges are muted by recent feedback calibration.',
      calibrationGate.reasonLabels.length > 0
        ? calibrationGate.reasonLabels
        : ['Recent feedback temporarily muted direct agenda chat nudges.'],
      ['Reset agenda nudge feedback or wait for the mute window to expire.'],
      calibrationGate.evidenceRefs,
      [
        {
          id: 'reset_feedback_mute',
          label: 'Reset nudge feedback',
          title: 'Clear only local agenda nudge feedback calibration',
        },
      ],
    );
  }

  const maxPerSession = options.maxPerSession ?? settings.maxSuggestionsPerSession;
  const shownCount = options.shownCount ?? 0;
  if (maxPerSession <= 0) {
    return blockedSummary(
      'session cap',
      'Aoi agenda nudges are disabled by the per-session cap.',
      ['The maximum direct suggestions per session is set to 0.'],
      ['Raise the Aoi max suggestions setting above 0.'],
      [],
      [
        {
          id: 'raise_session_cap',
          label: 'Raise cap',
          title: 'Increase the local per-session suggestion cap without running tools',
        },
      ],
    );
  }

  if (shownCount >= maxPerSession) {
    return blockedSummary(
      'session cap',
      'Aoi already used the direct suggestion budget for this session.',
      [`Shown ${shownCount} of ${maxPerSession} allowed direct suggestion(s).`],
      ['Dismiss or reset the session budget by starting a fresh panel session.'],
      [],
      [
        {
          id: 'raise_session_cap',
          label: 'Raise cap',
          title: 'Increase the local per-session suggestion cap without running tools',
        },
      ],
    );
  }

  const candidate = selectAoiAgendaChatNudge({
    status,
    activeProposals,
    blockedProposals,
    digest: params.digest,
    settings,
    options: {
      ...options,
      now,
      lastShownAt: undefined,
      shownDedupeKeys: undefined,
    },
  });

  if (candidate) {
    const reasonLabel = getAoiAgendaNudgeReasonLabel(candidate.reason);
    const cooldownMs = options.cooldownMs ?? AOI_AGENDA_CHAT_NUDGE_COOLDOWN_MS;
    if (
      typeof options.lastShownAt === 'number' &&
      options.lastShownAt > 0 &&
      now - options.lastShownAt < cooldownMs
    ) {
      const waitMs = cooldownMs - (now - options.lastShownAt);
      return {
        visible: true,
        statusLabel: 'cooling down',
        summaryLabel: 'Aoi has a qualified agenda path, but direct chat nudges are cooling down.',
        candidateLabel: `${reasonLabel}: ${candidate.dedupeKey}`,
        deliveryDecisionLabels: buildAoiAgendaNudgeDeliveryDecisionLabels({
          state: 'silent',
          reason: 'A qualified agenda nudge is held by the cooldown gate.',
          now,
          nextEligibleAt: options.lastShownAt + cooldownMs,
        }),
        reasonLabels: [`Cooldown remaining: ${formatAoiAgendaNudgeWait(waitMs)}.`],
        nextActionLabels: ['Aoi can speak again after the cooldown window expires.'],
        actions: [
          {
            id: 'refresh_autonomy',
            label: 'Refresh',
            title: 'Refresh Aoi autonomy state after waiting for cooldown',
          },
        ],
        lastActionLabels,
        lastDecisionLabels,
        lastDecisionFeedbackLabels,
        decisionFeedbackHistoryLabels,
        decisionFeedbackActions,
        evidenceRefs: candidate.evidenceRefs,
        tone: 'waiting',
      };
    }

    if (options.shownDedupeKeys?.has(candidate.dedupeKey)) {
      return {
        visible: true,
        statusLabel: 'already shown',
        summaryLabel: 'Aoi already surfaced the top agenda nudge in this session.',
        candidateLabel: `${reasonLabel}: ${candidate.dedupeKey}`,
        deliveryDecisionLabels: buildAoiAgendaNudgeDeliveryDecisionLabels({
          state: 'silent',
          reason: 'Duplicate protection is holding the already-delivered agenda nudge.',
          now,
          nextEligibleReason: 'waits for a different proposal, approval gate, or blocked gate.',
        }),
        reasonLabels: ['Duplicate protection blocks repeating the same direct agenda nudge.'],
        nextActionLabels: [
          'A new proposal, approval gate, or blocked gate can produce a fresh nudge.',
        ],
        actions: [
          {
            id: 'run_check',
            label: 'Run check',
            title: 'Run a bounded manual Aoi check for fresh agenda candidates',
          },
        ],
        lastActionLabels,
        lastDecisionLabels,
        lastDecisionFeedbackLabels,
        decisionFeedbackHistoryLabels,
        decisionFeedbackActions,
        evidenceRefs: candidate.evidenceRefs,
        tone: 'waiting',
      };
    }

    return {
      visible: true,
      statusLabel: 'ready',
      summaryLabel: 'Aoi has a direct agenda chat nudge ready.',
      candidateLabel: `${reasonLabel}: ${candidate.dedupeKey}`,
      deliveryDecisionLabels: buildAoiAgendaNudgeDeliveryDecisionLabels({
        state: 'ready',
        reason: 'All direct agenda delivery gates currently allow a compact chat nudge.',
        now,
      }),
      reasonLabels: [
        'Policy, quiet mode, notification, calibration, cooldown, and session gates all allow a nudge.',
      ],
      nextActionLabels: [
        'Aoi can surface the nudge as a compact chat message without running tools or app actions.',
      ],
      actions: [],
      lastActionLabels,
      lastDecisionLabels,
      lastDecisionFeedbackLabels,
      decisionFeedbackHistoryLabels,
      decisionFeedbackActions,
      evidenceRefs: candidate.evidenceRefs,
      tone: 'ready',
    };
  }

  return {
    visible: true,
    statusLabel: 'no candidate',
    summaryLabel: 'Aoi is allowed to speak, but no agenda item currently qualifies.',
    candidateLabel: summaryCountLabel,
    deliveryDecisionLabels: buildAoiAgendaNudgeDeliveryDecisionLabels({
      state: 'silent',
      reason: 'Aoi is allowed to speak, but no agenda item currently qualifies.',
      now,
      nextEligibleReason:
        'waits for stronger evidence, an approval-gated action, or a blocked safety gate.',
    }),
    reasonLabels: [
      'No accepted action, approval gate, blocked gate, or high-signal low-risk proposal qualified.',
    ],
    nextActionLabels: [
      'Aoi will wait for stronger evidence, an approval-gated action, or a blocked safety gate.',
    ],
    actions: [
      {
        id: 'run_check',
        label: 'Run check',
        title: 'Run a bounded manual Aoi check for fresh agenda candidates',
      },
      {
        id: 'refresh_autonomy',
        label: 'Refresh',
        title: 'Refresh Aoi autonomy state before checking again',
      },
    ],
    lastActionLabels,
    lastDecisionLabels,
    lastDecisionFeedbackLabels,
    decisionFeedbackHistoryLabels,
    decisionFeedbackActions,
    evidenceRefs: [],
    tone: 'waiting',
  };
}

export function buildAoiAgendaChatFollowUpContext(
  nudge: AoiAgendaChatNudge,
  prompt: string,
  now = Date.now(),
): AoiAgendaChatFollowUpContext {
  return {
    prompt: sanitizeAoiProposalDisplayText(prompt, 160),
    nudge,
    createdAt: now,
  };
}

export function classifyAoiAgendaChatFollowUpPrompt(
  prompt: string,
  nudge?: AoiAgendaChatNudge | null,
): AoiAgendaChatFollowUpIntent {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('quiet')) {
    return 'enable_quiet_mode';
  }
  if (normalized.includes('approval') || normalized.includes('gate')) {
    if (nudge?.reason === 'blocked_gate' || normalized.includes('blocked')) {
      return 'explain_blocked_gate';
    }
    return 'review_approval_gate';
  }
  if (normalized.includes('preview') || normalized.includes('prepared action')) {
    return 'preview_prepared_action';
  }
  if (normalized.includes('boundary') || normalized.includes('safety')) {
    return 'show_safety_boundary';
  }
  if (normalized.includes('alternative')) {
    return 'show_safe_alternative';
  }
  if (normalized.includes('next step') || normalized.includes('safe next')) {
    return 'show_safe_next_step';
  }
  if (normalized.includes('why') || normalized.includes('matter')) {
    return 'explain_why_now';
  }
  if (nudge?.reason === 'approval_waiting') {
    return 'review_approval_gate';
  }
  if (nudge?.reason === 'blocked_gate') {
    return 'explain_blocked_gate';
  }
  if (nudge?.reason === 'accepted_action_ready') {
    return 'preview_prepared_action';
  }
  return 'explain_why_now';
}

function findAoiAgendaProposal(
  proposals: readonly AoiProposal[],
  proposalId: string | undefined,
): AoiProposal | undefined {
  if (!proposalId) {
    return undefined;
  }
  return proposals.find((proposal) => proposal.id === proposalId);
}

function findAoiAgendaApproval(
  digest: AoiOperatorDigest | null | undefined,
  proposalId: string | undefined,
) {
  if (!proposalId) {
    return undefined;
  }
  return digest?.approvalInbox.find((item) => item.proposalId === proposalId);
}

function findAoiAgendaBlockedProposal(
  blockedProposals: readonly AoiAutonomyBlockedProposal[],
  proposalId: string | undefined,
): AoiAutonomyBlockedProposal | undefined {
  if (!proposalId) {
    return undefined;
  }
  return blockedProposals.find((proposal) => proposal.proposalId === proposalId);
}

function formatAoiAgendaEvidenceLine(evidenceRefs: readonly string[]): string {
  if (evidenceRefs.length === 0) {
    return 'Evidence: no evidence refs are attached yet; keep this as a review-only note.';
  }
  return `Evidence: ${evidenceRefs.slice(0, 4).join(', ')}${evidenceRefs.length > 4 ? `, +${evidenceRefs.length - 4} more` : ''}.`;
}

export function buildAoiAgendaChatFollowUpResponse(params: {
  context: AoiAgendaChatFollowUpContext;
  activeProposals?: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  digest?: AoiOperatorDigest | null;
}): AoiAgendaChatFollowUpResponse {
  const { context } = params;
  const nudge = context.nudge;
  const activeProposals = params.activeProposals ?? [];
  const blockedProposals = params.blockedProposals ?? [];
  const proposal = findAoiAgendaProposal(activeProposals, nudge.proposalId);
  const approval = findAoiAgendaApproval(params.digest, nudge.proposalId);
  const blockedProposal = findAoiAgendaBlockedProposal(blockedProposals, nudge.proposalId);
  const evidenceRefs = collectAoiAgendaEvidenceRefs(
    nudge.evidenceRefs,
    proposal?.evidenceRefs,
    approval?.evidenceRefs,
    blockedProposal?.evidenceRefs,
  );
  const intent = classifyAoiAgendaChatFollowUpPrompt(context.prompt, nudge);
  const title = sanitizeAoiProposalDisplayText(
    approval?.title ?? blockedProposal?.title ?? proposal?.title ?? 'Aoi agenda item',
    160,
  );
  const boundary =
    approval?.boundary ??
    (proposal
      ? `${proposal.acceptAction?.kind ?? 'prepared action'} remains behind ${proposal.requiredAutonomyLevel}; no tool runs until the existing proposal controls approve it.`
      : 'No tools, app actions, file changes, commits, or pushes start from this follow-up.');
  const safeNextAction =
    approval?.exactNextAction ??
    blockedProposal?.safeAlternative ??
    (proposal ? `Review proposal: ${proposal.title}.` : 'Open the Aoi panel and review the item.');
  let chatText = '';
  let shouldEnableQuietMode = false;
  let feedbackKind: AoiAgendaNudgeFeedbackKind = 'useful';

  if (intent === 'enable_quiet_mode') {
    shouldEnableQuietMode = true;
    feedbackKind = 'quieted';
    chatText = [
      'Aoi agenda quiet mode is on for this panel.',
      'I will keep observing and recording evidence, but I will not surface agenda chat nudges until quiet mode is turned off.',
      'Boundary: this changes only the Aoi panel quiet preference; no tools or external actions run.',
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  } else if (intent === 'review_approval_gate') {
    chatText = [
      `Approval gate: ${title}.`,
      `Exact next action: ${sanitizeAoiProposalDisplayText(safeNextAction, 220)}`,
      `Risk: ${approval?.risk ?? proposal?.risk ?? 'unknown'}; required level: ${
        approval?.requiredAutonomyLevel ?? proposal?.requiredAutonomyLevel ?? 'unknown'
      }.`,
      `Boundary: ${sanitizeAoiProposalDisplayText(boundary, 260)}`,
      'State: waiting for explicit approval; no tool has run from this follow-up.',
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  } else if (intent === 'preview_prepared_action') {
    chatText = [
      `Prepared action: ${title}.`,
      `Action kind: ${proposal?.acceptAction?.kind ?? approval?.actionKind ?? 'review'}.`,
      `Safe next step: ${sanitizeAoiProposalDisplayText(safeNextAction, 220)}`,
      `Boundary: ${sanitizeAoiProposalDisplayText(boundary, 260)}`,
      'State: this is a preview/explanation only; no command, file write, app action, commit, or push has run.',
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  } else if (intent === 'show_safety_boundary') {
    chatText = [
      `Safety boundary for ${title}:`,
      sanitizeAoiProposalDisplayText(boundary, 300),
      'Aoi can explain, preview, or point to the approval gate here, but execution stays behind the existing proposal controls.',
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  } else if (intent === 'explain_blocked_gate') {
    const reasons = blockedProposal?.reasons.length
      ? blockedProposal.reasons.join(', ')
      : 'the agenda item needs a stricter approval or safer prerequisite.';
    chatText = [
      `Blocked gate: ${title}.`,
      `Reason: ${sanitizeAoiProposalDisplayText(reasons, 240)}`,
      `Safe alternative: ${sanitizeAoiProposalDisplayText(safeNextAction, 220)}`,
      'State: blocked means Aoi should not execute or escalate this path automatically.',
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  } else if (intent === 'show_safe_alternative' || intent === 'show_safe_next_step') {
    chatText = [
      `Safe next step for ${title}:`,
      sanitizeAoiProposalDisplayText(safeNextAction, 260),
      `Boundary: ${sanitizeAoiProposalDisplayText(boundary, 260)}`,
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  } else {
    const whyNow =
      proposal?.reason ??
      approval?.title ??
      blockedProposal?.reasons.join(', ') ??
      'Aoi ranked this agenda item as currently relevant.';
    chatText = [
      `Why this agenda item matters now: ${title}.`,
      sanitizeAoiProposalDisplayText(whyNow, 260),
      `Safe next step: ${sanitizeAoiProposalDisplayText(safeNextAction, 220)}`,
      `Boundary: ${sanitizeAoiProposalDisplayText(boundary, 260)}`,
      formatAoiAgendaEvidenceLine(evidenceRefs),
    ].join('\n');
  }

  return {
    intent,
    chatText,
    suggestedReplies: shouldEnableQuietMode
      ? []
      : buildAoiAgendaSuggestedReplies(nudge.reason)
          .filter((reply) => reply !== context.prompt)
          .slice(0, 3),
    evidenceRefs,
    shouldEnableQuietMode,
    feedbackKind,
  };
}

export function buildAoiOperatorHealthPanelSummary(
  health: AoiOperatorHealthState | null | undefined,
  includeDetails = false,
): AoiOperatorHealthPanelSummary {
  if (!health) {
    return {
      visible: false,
      statusLabel: 'unknown',
      summaryLabel: 'No operator health snapshot',
      capabilityLabels: [],
      issueLabels: [],
      recommendationLabels: [],
      evidenceRefs: [],
      tone: 'healthy',
    };
  }
  const actionableIssues = health.issues.filter((issue) => issue.severity !== 'info');
  const visibleIssues = (actionableIssues.length > 0 ? actionableIssues : health.issues).slice(
    0,
    includeDetails ? 6 : 3,
  );
  return {
    visible: true,
    statusLabel: health.overallStatus.replace(/_/g, ' '),
    summaryLabel: sanitizeAoiProposalDisplayText(health.summary, 180),
    capabilityLabels: health.capabilities
      .filter((capability) => includeDetails || capability.status !== 'healthy')
      .slice(0, includeDetails ? 8 : 4)
      .map((capability) =>
        sanitizeAoiProposalDisplayText(
          `${capability.capability.replace(/_/g, ' ')}: ${capability.status}`,
          120,
        ),
      ),
    issueLabels: visibleIssues.map((issue) =>
      sanitizeAoiProposalDisplayText(
        issue.cannotKnow
          ? `${issue.title}. ${issue.cannotKnow}`
          : `${issue.title}. ${issue.summary}`,
        includeDetails ? 260 : 180,
      ),
    ),
    recommendationLabels: visibleIssues
      .map((issue) => issue.recommendation.label)
      .filter((label, index, all) => label && all.indexOf(label) === index)
      .slice(0, includeDetails ? 6 : 3)
      .map((label) => sanitizeAoiProposalDisplayText(label, 140)),
    evidenceRefs: includeDetails
      ? health.evidenceRefs.slice(0, 10).map((ref) => sanitizeAoiProposalDisplayText(ref, 180))
      : [],
    tone: health.overallStatus,
  };
}

function aoiPlaybookTone(playbook: AoiPlaybook): AoiPlaybookPanelSummary['tone'] {
  if (playbook.status === 'blocked') {
    return 'blocked';
  }
  if (playbook.status === 'completed' || playbook.status === 'archived') {
    return 'completed';
  }
  if (
    playbook.status === 'waiting' ||
    playbook.steps.some((step) => step.status.includes('waiting'))
  ) {
    return 'waiting';
  }
  return 'neutral';
}

export function buildAoiPlaybookPanelSummary(
  playbook: AoiPlaybook | null | undefined,
  includeDetails = false,
): AoiPlaybookPanelSummary {
  if (!playbook) {
    return {
      visible: false,
      statusLabel: 'no playbook',
      titleLabel: '',
      objectiveLabel: '',
      stepLabels: [],
      boundaryLabels: [],
      nextDecisionLabel: '',
      blockedPrerequisiteLabels: [],
      evidenceRefs: [],
      tone: 'neutral',
    };
  }
  const visibleSteps = playbook.steps.slice(0, includeDetails ? 8 : 5);
  const boundaryLabels = playbook.steps
    .filter(
      (step) =>
        step.executionBoundary.requiresApproval ||
        step.executionBoundary.commandCapable ||
        step.executionBoundary.mutationCapable,
    )
    .slice(0, includeDetails ? 6 : 3)
    .map((step) =>
      sanitizeAoiProposalDisplayText(
        `${step.title}: ${step.executionBoundary.summary}; auto-run no`,
        includeDetails ? 260 : 180,
      ),
    );
  const blockedPrerequisiteLabels = [
    ...playbook.blockedReasons,
    ...playbook.steps.flatMap((step) => step.blockedReasons),
  ]
    .filter((label, index, all) => label && all.indexOf(label) === index)
    .slice(0, includeDetails ? 6 : 3)
    .map((label) => sanitizeAoiProposalDisplayText(label, 160));

  return {
    visible: true,
    statusLabel: sanitizeAoiProposalDisplayText(playbook.status.replace(/_/g, ' '), 80),
    titleLabel: sanitizeAoiProposalDisplayText(playbook.title, 140),
    objectiveLabel: sanitizeAoiProposalDisplayText(playbook.objective, includeDetails ? 260 : 180),
    stepLabels: visibleSteps.map((step, index) =>
      sanitizeAoiProposalDisplayText(
        `${index + 1}. ${step.title}: ${step.status.replace(/_/g, ' ')}`,
        160,
      ),
    ),
    boundaryLabels,
    nextDecisionLabel: sanitizeAoiProposalDisplayText(playbook.nextRequiredDecision, 220),
    blockedPrerequisiteLabels,
    evidenceRefs: includeDetails
      ? playbook.evidenceRefs.slice(0, 10).map((ref) => sanitizeAoiProposalDisplayText(ref, 180))
      : [],
    tone: aoiPlaybookTone(playbook),
  };
}

export function buildAoiOperatorTimelinePanelSummary(
  summary: AoiOperatorTimelineSummary | null | undefined,
  includeDetails = false,
): AoiOperatorTimelinePanelSummary {
  if (!summary || summary.totalEventCount === 0) {
    return {
      visible: false,
      summaryLabel: 'No timeline events',
      eventLabels: [],
      exportLabel: 'No trace export',
      redactionLabel: '',
    };
  }
  const eventLabels = summary.newestMeaningfulEvents
    .slice(0, includeDetails ? 6 : 3)
    .map((event) =>
      sanitizeAoiProposalDisplayText(
        `${event.kind.replace(/_/g, ' ')}: ${event.title} - ${event.summary}`,
        includeDetails ? 260 : 160,
      ),
    );
  const exportLabel = summary.lastExportAt
    ? `Last trace export: ${new Date(summary.lastExportAt).toISOString()}`
    : 'No trace export';
  const redactionLabel =
    summary.lastExportRedactionCount > 0
      ? `${summary.lastExportRedactionCount} privacy replacement${summary.lastExportRedactionCount === 1 ? '' : 's'}`
      : summary.lastExportAt
        ? 'No privacy replacements'
        : '';

  return {
    visible: true,
    summaryLabel: sanitizeAoiProposalDisplayText(
      `${summary.totalEventCount} timeline event${summary.totalEventCount === 1 ? '' : 's'}`,
      120,
    ),
    eventLabels,
    exportLabel,
    redactionLabel,
  };
}

export function buildAoiAutonomySchedulerPanelSummary(
  state: AoiAutonomySchedulerState | null | undefined,
  includeDetails = false,
): AoiAutonomySchedulerPanelSummary {
  if (!state || (state.wakeupCount === 0 && state.sourceSchedules.length === 0)) {
    return {
      visible: false,
      summaryLabel: 'No scheduled wakeups',
      lastWakeupLabel: 'Not run',
      nextWakeupLabel: 'Ready',
      skippedSourceLabels: [],
      warningLabels: [],
      budgetLabel: '',
      evidenceRefs: [],
    };
  }

  const lastWakeup = state.recentWakeups[0];
  if (!lastWakeup) {
    return {
      visible: true,
      summaryLabel: `${state.wakeupCount} wakeup${state.wakeupCount === 1 ? '' : 's'} recorded`,
      lastWakeupLabel: 'No recent wakeup record',
      nextWakeupLabel:
        state.nextAllowedWakeupAt && state.nextAllowedWakeupAt > Date.now()
          ? `Next after ${new Date(state.nextAllowedWakeupAt).toLocaleTimeString()}`
          : 'Ready',
      skippedSourceLabels: [],
      warningLabels: [],
      budgetLabel: '',
      evidenceRefs: [],
    };
  }

  const skippedLimit = includeDetails ? 8 : 3;
  const skippedSourceLabels = lastWakeup.skippedSources
    .slice(0, skippedLimit)
    .map((source) =>
      sanitizeAoiProposalDisplayText(
        `${source.sourceId}: ${source.reasons.map((reason) => reason.replace(/_/g, ' ')).join(', ')}`,
        includeDetails ? 220 : 140,
      ),
    );
  const hiddenSkippedCount = Math.max(0, lastWakeup.skippedSources.length - skippedLimit);
  if (hiddenSkippedCount > 0) {
    skippedSourceLabels.push(`${hiddenSkippedCount} more skipped source(s)`);
  }

  const nextWakeupLabel =
    state.nextAllowedWakeupAt && state.nextAllowedWakeupAt > Date.now()
      ? `Next after ${new Date(state.nextAllowedWakeupAt).toLocaleTimeString()}`
      : 'Ready';
  const budgetLabel = `${lastWakeup.budget.maxSourceCount} source(s), ${lastWakeup.budget.maxGeneratedProposalCount} proposal(s), ${Math.round(
    lastWakeup.budget.maxBackgroundTickRuntimeMs / 1000,
  )}s tick budget`;

  return {
    visible: true,
    summaryLabel: sanitizeAoiProposalDisplayText(
      `${lastWakeup.reason.replace(/_/g, ' ')} ${lastWakeup.status}: ${lastWakeup.refreshedSourceIds.length} refreshed, ${lastWakeup.skippedSources.length} skipped`,
      160,
    ),
    lastWakeupLabel: `${lastWakeup.status} at ${new Date(lastWakeup.completedAt).toLocaleString()}`,
    nextWakeupLabel,
    skippedSourceLabels,
    warningLabels: lastWakeup.warnings
      .slice(0, includeDetails ? 6 : 2)
      .map((warning) => sanitizeAoiProposalDisplayText(warning, 180)),
    budgetLabel: sanitizeAoiProposalDisplayText(budgetLabel, 120),
    evidenceRefs: includeDetails ? [`wakeup:${lastWakeup.id}`] : [],
  };
}

function sanitizeAoiAcceptanceDashboardText(value: string, maxLength = 220): string {
  return sanitizeAoiProposalDisplayText(
    value
      .replace(
        /\b(?:do not leak|private|raw|full|secret)[^.!?]{0,100}\b(?:mail|email|calendar|event|note)?\s*body[^.!?]*(?:[.!?]|$)/gi,
        '[private body withheld]',
      )
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[external url]'),
    maxLength,
  );
}

function uniqueDashboardLabels(values: Array<string | undefined | null>, maxItems = 12): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const label = sanitizeAoiAcceptanceDashboardText(value ?? '', 220);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
    if (labels.length >= maxItems) {
      break;
    }
  }
  return labels;
}

function dashboardRefs(values: Array<string | undefined | null>, maxItems = 16): string[] {
  return uniqueDashboardLabels(values, maxItems);
}

function resolveAoiSourceFreshnessContracts(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiSourceFreshnessContract[] {
  return (
    input.sourceFreshnessContracts ??
    buildAoiSourceFreshnessContracts({
      sourceRegistry: input.sourceRegistry,
      workspaceSnapshot: input.workspaceSnapshot,
      now: input.now,
    })
  );
}

function buildAoiCurrentBriefPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiCurrentBriefPanel {
  const mission = input.mission;
  const workspace = input.workspaceSnapshot;
  const missionControl = input.missionControl;
  const missionControlSummary = buildAoiMissionControlDashboardSummary(missionControl);
  const missionMemory = input.missionMemory;
  const memoryContext = buildAoiMissionMemoryDashboardContext(missionMemory);
  const realityContext = buildAoiPersonalSourceRealityDashboardContext(
    input.personalSourceRealityCheck,
  );
  const workspaceSummary = workspace
    ? `${workspace.workspaceLabel}; ${
        workspace.git?.branchChanged
          ? `${workspace.git.previousBranchName ?? 'unknown'} -> ${workspace.git.branchName}`
          : (workspace.git?.branchName ?? 'no branch')
      }; ${formatAoiWorkspaceDirtyLabel(workspace)}`
    : 'No workspace signal';
  const validationLabel = workspace
    ? formatAoiWorkspaceValidationLabel(workspace)
    : missionMemory?.staleValidationRefs.length
      ? 'Validation stale in mission memory'
      : 'Validation unknown';
  const latestKiraEvent = input.timelineSummary?.newestMeaningfulEvents.find((event) =>
    event.kind.startsWith('kira'),
  );
  const kiraIssue = input.health?.issues.find((issue) => issue.capability === 'kira');
  const hasKiraPlaybook = input.playbooks?.some((playbook) =>
    playbook.steps.some(
      (step) => step.kind === 'create_kira_work' || step.kind === 'wait_for_external_event',
    ),
  );
  const kiraLabel = latestKiraEvent
    ? `${latestKiraEvent.title}: ${latestKiraEvent.summary}`
    : kiraIssue
      ? `${kiraIssue.title}: ${kiraIssue.summary}`
      : hasKiraPlaybook
        ? 'Kira/playbook state is available'
        : 'Kira status unknown';
  const statusLabel = mission
    ? sanitizeAoiAcceptanceDashboardText(mission.status.replace(/_/g, ' '), 80)
    : missionControl?.topMission
      ? sanitizeAoiAcceptanceDashboardText(
          `mission control ${missionControl.topMission.status.replace(/_/g, ' ')}`,
          80,
        )
      : memoryContext
        ? sanitizeAoiAcceptanceDashboardText(`mission memory ${memoryContext.freshnessLabel}`, 80)
        : 'no active mission';
  const missionLabel = mission
    ? sanitizeAoiAcceptanceDashboardText(
        `${mission.focusSummary || 'Mission focus unknown'}; next ${
          mission.nextRecommendedAction.label || 'none'
        }${memoryContext ? `; memory ${memoryContext.freshnessLabel}` : ''}`,
        220,
      )
    : missionControl?.topMission
      ? sanitizeAoiAcceptanceDashboardText(
          `${missionControl.topMission.lastKnownState}; next ${missionControl.topMission.nextSafeAction.label}`,
          220,
        )
      : memoryContext
        ? sanitizeAoiAcceptanceDashboardText(memoryContext.currentBriefLabel, 220)
        : realityContext?.currentBriefLabels[0]
          ? sanitizeAoiAcceptanceDashboardText(realityContext.currentBriefLabels[0], 220)
          : 'No mission focus yet';

  return {
    visible: Boolean(
      mission ||
      workspace ||
      latestKiraEvent ||
      kiraIssue ||
      hasKiraPlaybook ||
      missionControlSummary.visible ||
      memoryContext ||
      realityContext,
    ),
    statusLabel,
    missionLabel,
    workspaceLabel: sanitizeAoiAcceptanceDashboardText(workspaceSummary, 220),
    validationLabel: sanitizeAoiAcceptanceDashboardText(validationLabel, 160),
    kiraLabel: sanitizeAoiAcceptanceDashboardText(kiraLabel, 180),
    evidenceRefs: dashboardRefs([
      ...(mission?.evidenceRefs ?? []),
      mission?.lastMeaningfulEventRef,
      mission?.nextRecommendedAction.ref,
      ...(workspace?.evidenceRefs ?? []),
      ...(latestKiraEvent?.evidenceRefs ?? []),
      ...(kiraIssue?.evidenceRefs ?? []),
      ...(missionControl?.evidenceRefs ?? []),
      ...(memoryContext?.evidenceRefs ?? []),
      ...(realityContext?.evidenceRefs ?? []),
      missionControl ? `mission-control:${missionControl.id}` : undefined,
      missionMemory ? `mission-memory:${missionMemory.id}` : undefined,
      input.personalSourceRealityCheck
        ? `personal-source-reality:${input.personalSourceRealityCheck.id}`
        : undefined,
    ]),
  };
}

function buildAoiBlindSpotsPanel(input: AoiOperatorAcceptanceDashboardInput): AoiBlindSpotsPanel {
  const missionControl = input.missionControl;
  const missionMemory = input.missionMemory;
  const memoryContext = buildAoiMissionMemoryDashboardContext(missionMemory);
  const realityContext = buildAoiPersonalSourceRealityDashboardContext(
    input.personalSourceRealityCheck,
  );
  const sourceFreshnessContext = buildAoiSourceFreshnessDashboardContext(
    resolveAoiSourceFreshnessContracts(input),
  );
  const blindSpotSources =
    input.sourceRegistry?.sources.filter(
      (source) =>
        !source.enabled ||
        (isAoiPersonalSignalSourceKind(source.kind) &&
          !source.allowedOperations.includes('summarize')),
    ) ?? [];
  const issueLabels =
    input.health?.issues
      .filter(
        (issue) =>
          issue.severity !== 'info' ||
          Boolean(issue.cannotKnow) ||
          /disabled|disconnected|revoked|stale|degraded|missing/i.test(issue.code),
      )
      .map((issue) =>
        issue.cannotKnow
          ? `${issue.title}: ${issue.cannotKnow}`
          : `${issue.title}: ${issue.summary}`,
      ) ?? [];
  const sourceLabels = blindSpotSources.map((source) =>
    source.enabled
      ? `${source.label}: metadata only; private bodies are outside consent scope.`
      : `${source.label}: disabled source; Aoi cannot use it as context.`,
  );
  const timelineLabels =
    input.timelineSummary?.newestMeaningfulEvents
      .filter((event) =>
        /blind|disabled|disconnected|stale|degraded|cannot know/i.test(event.summary),
      )
      .map((event) => `${event.title}: ${event.summary}`) ?? [];
  const missionControlLabels =
    missionControl?.items
      .filter(
        (item) =>
          item.status === 'needs_validation_preview' ||
          item.status === 'stale' ||
          item.status === 'needs_operator_input' ||
          item.status === 'blocked',
      )
      .map((item) => `${item.missionId}: ${item.status}; ${item.nextSafeAction.reason}`) ?? [];
  const labels = uniqueDashboardLabels(
    [
      ...issueLabels,
      ...sourceLabels,
      ...timelineLabels,
      ...missionControlLabels,
      ...(memoryContext?.blindSpotLabels ?? []),
      ...(realityContext?.blindSpotLabels ?? []),
      ...sourceFreshnessContext.blindSpotLabels,
    ],
    8,
  );

  return {
    visible: labels.length > 0,
    statusLabel: labels.length > 0 ? `${labels.length} blind spot(s)` : 'No known blind spots',
    blindSpotLabels: labels,
    sourceLabels: uniqueDashboardLabels(sourceLabels, 6),
    evidenceRefs: dashboardRefs([
      ...(input.health?.issues.flatMap((issue) => issue.evidenceRefs) ?? []),
      ...blindSpotSources.map((source) => `environment-source:${source.id}`),
      ...(input.timelineSummary?.newestMeaningfulEvents.flatMap((event) => event.evidenceRefs) ??
        []),
      ...(missionControl?.evidenceRefs ?? []),
      ...(memoryContext?.evidenceRefs ?? []),
      ...(realityContext?.evidenceRefs ?? []),
      ...sourceFreshnessContext.evidenceRefs,
      missionControl ? `mission-control:${missionControl.id}` : undefined,
      missionMemory ? `mission-memory:${missionMemory.id}` : undefined,
      input.personalSourceRealityCheck
        ? `personal-source-reality:${input.personalSourceRealityCheck.id}`
        : undefined,
    ]),
  };
}

function buildAoiSourceFreshnessPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiSourceFreshnessPanel {
  const context = buildAoiSourceFreshnessDashboardContext(
    resolveAoiSourceFreshnessContracts(input),
  );
  const sanitizeLabels = (labels: string[], maxChars = 220): string[] =>
    labels.map((label) => sanitizeAoiAcceptanceDashboardText(label, maxChars));
  return {
    visible: context.visible,
    statusLabel: sanitizeAoiAcceptanceDashboardText(context.statusLabel, 140),
    topStaleSourceLabels: sanitizeLabels(context.topStaleSourceLabels),
    disconnectedSourceLabels: sanitizeLabels(context.disconnectedSourceLabels),
    revokedSourceLabels: sanitizeLabels(context.revokedSourceLabels),
    metadataOnlyBoundaryLabels: sanitizeLabels(context.metadataOnlyBoundaryLabels),
    lastObservedLabels: sanitizeLabels(context.lastObservedLabels),
    lastSuccessfulReadLabels: sanitizeLabels(context.lastSuccessfulReadLabels),
    evidenceRefs: context.evidenceRefs,
  };
}

function formatAoiWorkOrderStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function buildAoiBoundedWorkOrderPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiBoundedWorkOrderPanel {
  const workOrders = input.boundedWorkOrders ?? [];
  if (workOrders.length <= 0) {
    return {
      visible: false,
      statusLabel: 'No bounded work orders',
      eligibleWorkOrderLabels: [],
      blockedReasonLabels: [],
      exactNextApprovalLabels: [],
      checkpointLabels: [],
      rollbackLabels: [],
      evidenceRefs: [],
    };
  }

  const eligible = workOrders.filter((order) => order.policyResult.status !== 'blocked');
  const blocked = workOrders.filter((order) => order.policyResult.status === 'blocked');
  const eligibleWorkOrderLabels = uniqueDashboardLabels(
    eligible.map(
      (order) =>
        `${order.objective}: ${formatAoiWorkOrderStatus(order.policyResult.status)}; scope=${[
          ...order.scope.files,
          ...order.scope.modules,
          ...order.scope.affectedSurfaces,
        ]
          .slice(0, 3)
          .join(', ')}`,
    ),
    6,
  );
  const blockedReasonLabels = uniqueDashboardLabels(
    blocked.flatMap((order) =>
      order.policyResult.blockedReasons.map((reason) => `${order.objective}: ${reason}`),
    ),
    8,
  );
  const exactNextApprovalLabels = uniqueDashboardLabels(
    workOrders
      .filter((order) => order.approval.required || order.policyResult.status !== 'preview_only')
      .map(
        (order) =>
          `${order.objective}: ${order.policyResult.exactNextApproval}; fingerprint=${order.approval.approvalFingerprint}`,
      ),
    8,
  );
  const checkpointLabels = uniqueDashboardLabels(
    workOrders.map(
      (order) =>
        `${order.objective}: checkpoint ${order.checkpoint.kind} ${
          order.checkpoint.available ? 'available' : 'missing'
        }`,
    ),
    6,
  );
  const rollbackLabels = uniqueDashboardLabels(
    workOrders.map(
      (order) =>
        `${order.objective}: rollback ${order.rollback.kind}; available=${order.rollback.available}; guarantee=${order.rollback.guarantee}`,
    ),
    6,
  );

  return {
    visible: true,
    statusLabel: sanitizeAoiAcceptanceDashboardText(
      `${eligible.length}/${workOrders.length} work order(s) eligible for preview or review`,
      120,
    ),
    eligibleWorkOrderLabels,
    blockedReasonLabels,
    exactNextApprovalLabels,
    checkpointLabels,
    rollbackLabels,
    evidenceRefs: dashboardRefs([
      ...workOrders.flatMap((order) => [
        `work-order:${order.id}`,
        `work-order-approval:${order.approval.approvalFingerprint}`,
        ...order.evidenceRefs,
      ]),
    ]),
  };
}

function buildAoiNextSafeActionPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiNextSafeActionPanel {
  const missionControl = input.missionControl;
  if (missionControl?.topMission) {
    const topMission = missionControl.topMission;
    return {
      visible: true,
      actionLabel: sanitizeAoiAcceptanceDashboardText(topMission.nextSafeAction.label, 180),
      sourceLabel: sanitizeAoiAcceptanceDashboardText(
        `mission-control:${topMission.missionId}`,
        120,
      ),
      boundaryLabel: sanitizeAoiAcceptanceDashboardText(
        topMission.nextSafeAction.boundaryLabel,
        220,
      ),
      blockedReasonLabels: uniqueDashboardLabels(
        [
          ...topMission.staleReasonLabels,
          ...(topMission.status === 'waiting_on_external' ? ['pending external evidence'] : []),
          ...(topMission.status === 'waiting_on_approval' ? ['pending approval'] : []),
          ...(topMission.status === 'needs_operator_input' || topMission.status === 'blocked'
            ? ['operator input required']
            : []),
        ],
        8,
      ),
      evidenceRefs: dashboardRefs([
        ...topMission.evidenceRefs,
        ...missionControl.evidenceRefs,
        `mission-control:${missionControl.id}`,
      ]),
    };
  }
  const missionMemory = input.missionMemory;
  const memoryContext = buildAoiMissionMemoryDashboardContext(missionMemory);
  const realityContext = buildAoiPersonalSourceRealityDashboardContext(
    input.personalSourceRealityCheck,
  );
  if (missionMemory && memoryContext && memoryContext.blockedReasonLabels.length > 0) {
    return {
      visible: true,
      actionLabel: sanitizeAoiAcceptanceDashboardText(memoryContext.nextSafeActionLabel, 180),
      sourceLabel: sanitizeAoiAcceptanceDashboardText(`mission-memory:${missionMemory.id}`, 120),
      boundaryLabel: sanitizeAoiAcceptanceDashboardText(memoryContext.boundaryLabel, 220),
      blockedReasonLabels: memoryContext.blockedReasonLabels,
      evidenceRefs: dashboardRefs([
        ...memoryContext.evidenceRefs,
        `mission-memory:${missionMemory.id}`,
      ]),
    };
  }
  const playbook = input.playbooks?.find(
    (item) => item.status !== 'completed' && item.status !== 'archived',
  );
  const nextStep = playbook?.steps.find((step) => step.id === playbook.nextStepId);
  if (playbook && nextStep) {
    const boundary = nextStep.executionBoundary.requiresApproval
      ? nextStep.executionBoundary.summary
      : nextStep.executionBoundary.mutationCapable || nextStep.executionBoundary.commandCapable
        ? `${nextStep.executionBoundary.summary}; preview only until approved.`
        : nextStep.executionBoundary.summary || 'Read-only or preview-only next step.';
    return {
      visible: true,
      actionLabel: sanitizeAoiAcceptanceDashboardText(
        playbook.nextRequiredDecision || nextStep.summary,
        220,
      ),
      sourceLabel: sanitizeAoiAcceptanceDashboardText(`playbook:${playbook.id}`, 120),
      boundaryLabel: sanitizeAoiAcceptanceDashboardText(boundary, 220),
      blockedReasonLabels: uniqueDashboardLabels(
        [...playbook.blockedReasons, ...nextStep.blockedReasons],
        6,
      ),
      evidenceRefs: dashboardRefs([
        `playbook:${playbook.id}`,
        ...playbook.evidenceRefs,
        ...nextStep.evidenceRefs,
      ]),
    };
  }
  if (input.personalSourceRealityCheck && realityContext?.nextSafeActionLabel) {
    return {
      visible: true,
      actionLabel: sanitizeAoiAcceptanceDashboardText(realityContext.nextSafeActionLabel, 180),
      sourceLabel: sanitizeAoiAcceptanceDashboardText(
        `personal-source-reality:${input.personalSourceRealityCheck.id}`,
        120,
      ),
      boundaryLabel:
        'Personal metadata can only justify a preview or blind-spot note; it does not execute commands.',
      blockedReasonLabels: realityContext.blockedReasonLabels,
      evidenceRefs: dashboardRefs([
        ...realityContext.evidenceRefs,
        `personal-source-reality:${input.personalSourceRealityCheck.id}`,
      ]),
    };
  }
  if (input.workspaceSnapshot) {
    const recommendation = getAoiWorkspaceRecommendation(input.workspaceSnapshot);
    return {
      visible: recommendation.recommendationTone === 'recommendation',
      actionLabel: sanitizeAoiAcceptanceDashboardText(recommendation.recommendationLabel, 180),
      sourceLabel: 'workspace signal',
      boundaryLabel:
        'Dashboard can only recommend or prepare a preview; it does not run validation.',
      blockedReasonLabels: [],
      evidenceRefs: dashboardRefs(input.workspaceSnapshot.evidenceRefs),
    };
  }
  const digestItem = input.digest?.items.find((item) => !item.hidden && item.nextSafeAction);
  if (digestItem) {
    return {
      visible: true,
      actionLabel: sanitizeAoiAcceptanceDashboardText(digestItem.nextSafeAction, 180),
      sourceLabel: sanitizeAoiAcceptanceDashboardText(digestItem.sourceRefs.join(', '), 140),
      boundaryLabel:
        'Digest recommendation is display-only until the user approves a concrete action.',
      blockedReasonLabels: [],
      evidenceRefs: dashboardRefs(digestItem.evidenceRefs),
    };
  }
  if (missionMemory && memoryContext) {
    return {
      visible: true,
      actionLabel: sanitizeAoiAcceptanceDashboardText(memoryContext.nextSafeActionLabel, 180),
      sourceLabel: sanitizeAoiAcceptanceDashboardText(`mission-memory:${missionMemory.id}`, 120),
      boundaryLabel: sanitizeAoiAcceptanceDashboardText(memoryContext.boundaryLabel, 220),
      blockedReasonLabels: memoryContext.blockedReasonLabels,
      evidenceRefs: dashboardRefs([
        ...memoryContext.evidenceRefs,
        `mission-memory:${missionMemory.id}`,
      ]),
    };
  }
  return {
    visible: false,
    actionLabel: 'No safe next action',
    sourceLabel: 'No source selected',
    boundaryLabel: 'Dashboard display only; no execution authority.',
    blockedReasonLabels: [],
    evidenceRefs: [],
  };
}

function buildAoiWhyQuietPanel(input: AoiOperatorAcceptanceDashboardInput): AoiWhyQuietPanel {
  const missionControlQuiet =
    input.missionControl?.health.whyQuiet &&
    !/may brief/i.test(input.missionControl.health.whyQuiet)
      ? [input.missionControl.health.whyQuiet]
      : [];
  const shadowQuiet = input.shadowReport?.decisions.filter(
    (decision) => decision.kind === 'would_stay_quiet',
  );
  const shadowLabels =
    shadowQuiet?.map(
      (decision) => `${decision.silenceReason ?? 'Aoi stayed quiet.'} (${decision.policyResult})`,
    ) ?? [];
  const digestHidden =
    input.digest?.items
      .filter((item) => item.hidden || item.lane === 'hidden_by_quiet_mode')
      .map((item) => `${item.title}: ${item.summary}`) ?? [];
  const quietWindow = input.digest?.quietWindow?.enabled
    ? [`Quiet mode: ${input.digest.quietWindow.reason}`]
    : [];
  const labels = uniqueDashboardLabels(
    [...missionControlQuiet, ...shadowLabels, ...digestHidden, ...quietWindow],
    6,
  );

  return {
    visible: labels.length > 0,
    reasonLabels: labels.length > 0 ? labels : ['No quiet suppression recorded'],
    quietDecisionRefs: dashboardRefs(
      shadowQuiet?.map((decision) => `shadow-decision:${decision.id}`) ?? [],
    ),
    evidenceRefs: dashboardRefs([
      ...(input.missionControl?.evidenceRefs ?? []),
      ...(shadowQuiet?.flatMap((decision) => decision.evidenceRefs) ?? []),
      ...(input.digest?.items
        .filter((item) => item.hidden || item.lane === 'hidden_by_quiet_mode')
        .flatMap((item) => item.evidenceRefs) ?? []),
    ]),
  };
}

function buildAoiPendingApprovalPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiPendingApprovalPanel {
  const missionControl = input.missionControl;
  const missionMemory = input.missionMemory;
  const memoryContext = buildAoiMissionMemoryDashboardContext(missionMemory);
  const missionControlApprovals =
    missionControl?.items
      .filter((item) => item.approvalRefs.length > 0 || item.status === 'waiting_on_approval')
      .map(
        (item) =>
          `${item.missionId}: ${item.nextSafeAction.label}; ${item.approvalRefs.join(', ')}`,
      ) ?? [];
  const digestApprovals =
    input.digest?.approvalInbox.map(
      (item) =>
        `${item.title}: ${item.exactNextAction} (${item.risk}, ${item.requiredAutonomyLevel})`,
    ) ?? [];
  const commandApprovals =
    input.approvedCommandPolicies?.map(
      (policy) =>
        `${policy.allowed ? 'command preview' : 'blocked command'}: ${
          policy.displayCommand
        }; cwd=${policy.cwdLabel}; fingerprint=${policy.approvalFingerprint}`,
    ) ?? [];
  const playbookApprovals =
    input.playbooks?.flatMap((playbook) =>
      playbook.steps
        .filter(
          (step) =>
            step.status === 'waiting_for_approval' || step.executionBoundary.requiresApproval,
        )
        .map((step) => `${playbook.title}: ${step.title}; ${step.executionBoundary.summary}`),
    ) ?? [];
  const workOrderApprovals =
    input.boundedWorkOrders
      ?.filter((order) => order.approval.required || order.policyResult.status !== 'preview_only')
      .map(
        (order) =>
          `${order.objective}: ${order.policyResult.exactNextApproval}; fingerprint=${order.approval.approvalFingerprint}`,
      ) ?? [];
  const memoryApprovals = memoryContext?.pendingApprovalLabels ?? [];
  const labels = uniqueDashboardLabels(
    [
      ...missionControlApprovals,
      ...digestApprovals,
      ...commandApprovals,
      ...playbookApprovals,
      ...workOrderApprovals,
      ...memoryApprovals,
    ],
    8,
  );
  const boundaryLabels = uniqueDashboardLabels(
    [
      ...(missionControl?.items
        .filter((item) => item.approvalRefs.length > 0 || item.status === 'waiting_on_approval')
        .map((item) => item.nextSafeAction.boundaryLabel) ?? []),
      ...(input.digest?.approvalInbox.map((item) => item.boundary) ?? []),
      ...(input.approvedCommandPolicies?.map(
        (policy) =>
          `cwd=${policy.cwdLabel}; fingerprint=${policy.approvalFingerprint}; ${policy.rationale.join('; ')}`,
      ) ?? []),
      ...(input.playbooks?.flatMap((playbook) =>
        playbook.steps
          .filter(
            (step) =>
              step.status === 'waiting_for_approval' || step.executionBoundary.requiresApproval,
          )
          .map((step) => step.executionBoundary.summary),
      ) ?? []),
      ...(input.boundedWorkOrders
        ?.filter((order) => order.approval.required || order.policyResult.status !== 'preview_only')
        .map(
          (order) =>
            `${order.policyResult.exactNextApproval}; scope=${order.scope.scopeHash}; fingerprint=${order.approval.approvalFingerprint}`,
        ) ?? []),
      ...(memoryContext ? [memoryContext.boundaryLabel] : []),
    ],
    8,
  );

  return {
    visible: labels.length > 0,
    approvalLabels: labels,
    boundaryLabels,
    riskLabels: uniqueDashboardLabels(
      [
        ...(input.digest?.approvalInbox.map(
          (item) => `${item.risk} risk ${item.requiredAutonomyLevel}`,
        ) ?? []),
        ...(input.approvedCommandPolicies?.map((policy) => `${policy.risk} risk L5`) ?? []),
        ...(input.boundedWorkOrders
          ?.filter(
            (order) => order.approval.required || order.policyResult.status !== 'preview_only',
          )
          .map((order) => `${order.risk.level} risk ${order.approval.requiredAutonomyLevel}`) ??
          []),
      ],
      6,
    ),
    evidenceRefs: dashboardRefs([
      ...(missionControl?.items.flatMap((item) => item.approvalRefs) ?? []),
      ...(missionControl?.evidenceRefs ?? []),
      ...(input.digest?.approvalInbox.flatMap((item) => [
        `proposal:${item.proposalId}`,
        ...item.evidenceRefs,
      ]) ?? []),
      ...(input.approvedCommandPolicies?.map(
        (policy) => `command-approval:${policy.approvalFingerprint}`,
      ) ?? []),
      ...(input.playbooks?.flatMap((playbook) => [
        `playbook:${playbook.id}`,
        ...playbook.evidenceRefs,
      ]) ?? []),
      ...(input.boundedWorkOrders?.flatMap((order) => [
        `work-order:${order.id}`,
        `work-order-approval:${order.approval.approvalFingerprint}`,
        ...order.evidenceRefs,
      ]) ?? []),
      ...(memoryContext?.evidenceRefs ?? []),
      missionControl ? `mission-control:${missionControl.id}` : undefined,
      missionMemory ? `mission-memory:${missionMemory.id}` : undefined,
    ]),
  };
}

function buildAoiReplayHealthPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiReplayHealthPanel {
  const realityContext = buildAoiPersonalSourceRealityDashboardContext(
    input.personalSourceRealityCheck,
  );
  const replayReports = input.builtInReplayReports ?? [];
  const replayFailed = replayReports.filter((report) => !report.passed);
  const builtInReplayLabel =
    replayReports.length > 0
      ? `${replayReports.length - replayFailed.length}/${replayReports.length} built-in replay passed`
      : 'No built-in replay report';
  const jarvis = input.jarvisAcceptanceReport;
  const jarvisLabel = jarvis
    ? `${jarvis.passedMetricCount}/${jarvis.metricCount} JARVIS acceptance metrics passed`
    : 'No JARVIS acceptance report';
  const shadow = input.shadowReport;
  const shadowLabel = shadow
    ? `${shadow.metrics.labeledDecisionCount}/${shadow.metrics.totalDecisions} shadow decisions labeled; useful ${shadow.metrics.usefulRate}; wrong source ${shadow.metrics.wrongSourceRate}`
    : 'No shadow label report';
  const failedMetricIds = uniqueDashboardLabels(
    [
      ...replayReports.flatMap((report) =>
        report.metrics.filter((metric) => !metric.passed).map((metric) => metric.id),
      ),
      ...(jarvis?.failedMetrics.map((metric) => metric.id) ?? []),
      ...(shadow
        ? [
            ...(shadow.metrics.unsafeShadowDecisionCount > 0 ? ['shadow.unsafe'] : []),
            ...(shadow.metrics.wrongSourceRate > 0 ? ['shadow.wrong_source'] : []),
            ...(shadow.metrics.tooMuchRate > 0 ? ['shadow.too_much'] : []),
          ]
        : []),
      ...(realityContext?.failedMetricIds ?? []),
    ],
    10,
  );
  const promotedFixtureLabels = uniqueDashboardLabels(
    input.promotedFixtureCandidates?.map(
      (candidate) => `${candidate.status}: ${candidate.label} (${candidate.id})`,
    ) ?? [],
    5,
  );
  const failedCount = failedMetricIds.length;

  return {
    visible: Boolean(
      replayReports.length || jarvis || shadow || promotedFixtureLabels.length || failedCount,
    ),
    statusLabel:
      failedCount > 0 ? `${failedCount} replay issue(s)` : 'Replay health passing or unavailable',
    builtInReplayLabel: sanitizeAoiAcceptanceDashboardText(builtInReplayLabel, 140),
    jarvisAcceptanceLabel: sanitizeAoiAcceptanceDashboardText(jarvisLabel, 160),
    shadowLabel: sanitizeAoiAcceptanceDashboardText(shadowLabel, 180),
    failedMetricIds,
    promotedFixtureLabels,
    evidenceRefs: dashboardRefs([
      ...replayReports.flatMap((report) => report.metrics.flatMap((metric) => metric.evidenceRefs)),
      ...(jarvis?.evidenceRefs ?? []),
      ...(shadow?.evidenceRefs ?? []),
      ...(input.promotedFixtureCandidates?.flatMap((candidate) => candidate.evidenceRefs) ?? []),
      ...(realityContext?.evidenceRefs ?? []),
    ]),
  };
}

function hasAoiJarvisReadinessEvidence(input: AoiOperatorAcceptanceDashboardInput): boolean {
  return Boolean(
    input.jarvisReadinessScorecard ||
    input.shadowReport ||
    input.feedbackInbox ||
    input.fieldShadowReport ||
    input.jarvisAcceptanceReport ||
    input.personalSourceRealityCheck ||
    input.missionControl ||
    input.sourceRegistry ||
    input.workspaceSnapshot ||
    input.builtInReplayReports?.length ||
    input.boundedWorkOrders?.length ||
    input.sourceFreshnessContracts?.length ||
    input.promotedFixtureCandidates?.length,
  );
}

function formatAoiJarvisReadinessLevel(level: string): string {
  return level.replace(/_/g, ' ');
}

function formatAoiJarvisModeRecommendation(value: string): string {
  switch (value) {
    case 'tighten_or_rollback':
      return 'Tighten or roll back current mode';
    case 'candidate_for_higher_trust':
      return 'Candidate for higher trust after operator approval';
    case 'remain_current_mode':
    default:
      return 'Remain in current mode';
  }
}

function buildAoiJarvisReadinessPanel(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiJarvisReadinessPanel {
  if (!hasAoiJarvisReadinessEvidence(input)) {
    return {
      visible: false,
      statusLabel: 'No JARVIS readiness evidence',
      levelLabel: 'Readiness level unavailable',
      scoreLabel: 'No readiness score',
      modeRecommendationLabel: 'Remain in current mode',
      gateLabels: [],
      recommendationLabels: [],
      evidenceRefs: [],
    };
  }
  const scorecard =
    input.jarvisReadinessScorecard ??
    buildAoiJarvisReadinessScorecard({
      sessionPath: input.sessionPath,
      now: input.now,
      shadowReport: input.shadowReport,
      feedbackInbox: input.feedbackInbox,
      fieldShadowReport: input.fieldShadowReport,
      builtInReplayReports: input.builtInReplayReports,
      jarvisAcceptanceReport: input.jarvisAcceptanceReport,
      personalSourceRealityCheck: input.personalSourceRealityCheck,
      sourceFreshnessContracts: resolveAoiSourceFreshnessContracts(input),
      missionControl: input.missionControl,
      boundedWorkOrders: input.boundedWorkOrders,
      promotedFixtureCandidates: input.promotedFixtureCandidates,
    });
  const blockingOrWarningGates = scorecard.gates.filter((gate) => gate.status !== 'pass');
  const gateLabels = uniqueDashboardLabels(
    (blockingOrWarningGates.length > 0 ? blockingOrWarningGates : scorecard.gates.slice(0, 3)).map(
      (gate) => `${gate.status}: ${gate.label}; ${gate.reason}`,
    ),
    6,
  );
  const recommendationLabels = uniqueDashboardLabels(
    scorecard.recommendations.map((item) => `${item.severity}: ${item.label}; ${item.action}`),
    5,
  );

  return {
    visible: true,
    statusLabel: sanitizeAoiAcceptanceDashboardText(
      `${scorecard.gateStatus}; ${scorecard.score}/100 readiness`,
      120,
    ),
    levelLabel: sanitizeAoiAcceptanceDashboardText(
      `Readiness level: ${formatAoiJarvisReadinessLevel(scorecard.level)}`,
      120,
    ),
    scoreLabel: sanitizeAoiAcceptanceDashboardText(`${scorecard.score}/100 score`, 80),
    modeRecommendationLabel: sanitizeAoiAcceptanceDashboardText(
      formatAoiJarvisModeRecommendation(scorecard.modeRecommendation),
      140,
    ),
    gateLabels,
    recommendationLabels,
    evidenceRefs: dashboardRefs([
      `jarvis-readiness:${scorecard.id}`,
      ...scorecard.evidenceRefs,
      ...scorecard.blockerRefs,
    ]),
  };
}

function buildAoiOperatorFeedbackInboxPanel(
  inbox: AoiOperatorFeedbackInbox | null | undefined,
): AoiOperatorFeedbackInboxPanel {
  if (!inbox || inbox.inboxCount <= 0) {
    return {
      visible: false,
      inboxCountLabel: 'No field feedback inbox items',
      unlabeledCountLabel: '0 unlabeled',
      labelDistributionLabels: [],
      topSourceKindLabels: [],
      promotionCandidateLabel: '0 promotion candidates',
      calibrationInputLabel: '0 calibration inputs',
      evidenceRefs: [],
    };
  }
  const labelDistributionLabels = uniqueDashboardLabels(
    Object.entries(inbox.labelDistribution)
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label.replace(/_/g, ' ')} ${count}`),
    6,
  );
  const topSourceKindLabels = uniqueDashboardLabels(
    inbox.topSourceKindsNeedingReview.map(
      (item) =>
        `${item.sourceKind.replace(/_/g, ' ')} ${item.unlabeledCount}/${item.count} unlabeled`,
    ),
    6,
  );

  return {
    visible: true,
    inboxCountLabel: `${inbox.inboxCount} field feedback item${inbox.inboxCount === 1 ? '' : 's'}`,
    unlabeledCountLabel: `${inbox.unlabeledCount} unlabeled`,
    labelDistributionLabels,
    topSourceKindLabels,
    promotionCandidateLabel: `${inbox.promotionCandidateCount} promotion candidate${
      inbox.promotionCandidateCount === 1 ? '' : 's'
    }`,
    calibrationInputLabel: `${inbox.calibrationInputCount} calibration input${
      inbox.calibrationInputCount === 1 ? '' : 's'
    }`,
    evidenceRefs: dashboardRefs([
      ...inbox.evidenceRefs,
      ...inbox.topSourceKindsNeedingReview.flatMap((item) => item.evidenceRefs),
    ]),
  };
}

export function buildAoiOperatorAcceptanceDashboard(
  input: AoiOperatorAcceptanceDashboardInput,
): AoiOperatorAcceptanceDashboard {
  const missionControl = buildAoiMissionControlDashboardSummary(input.missionControl);
  const currentBrief = buildAoiCurrentBriefPanel(input);
  const blindSpots = buildAoiBlindSpotsPanel(input);
  const sourceFreshness = buildAoiSourceFreshnessPanel(input);
  const boundedWorkOrders = buildAoiBoundedWorkOrderPanel(input);
  const nextSafeAction = buildAoiNextSafeActionPanel(input);
  const whyQuiet = buildAoiWhyQuietPanel(input);
  const pendingApproval = buildAoiPendingApprovalPanel(input);
  const replayHealth = buildAoiReplayHealthPanel(input);
  const jarvisReadiness = buildAoiJarvisReadinessPanel(input);
  const feedbackInbox = buildAoiOperatorFeedbackInboxPanel(input.feedbackInbox);
  const evidenceRefs = dashboardRefs([
    ...missionControl.evidenceRefs,
    ...currentBrief.evidenceRefs,
    ...blindSpots.evidenceRefs,
    ...sourceFreshness.evidenceRefs,
    ...boundedWorkOrders.evidenceRefs,
    ...nextSafeAction.evidenceRefs,
    ...whyQuiet.evidenceRefs,
    ...pendingApproval.evidenceRefs,
    ...replayHealth.evidenceRefs,
    ...jarvisReadiness.evidenceRefs,
    ...feedbackInbox.evidenceRefs,
  ]);

  return {
    version: 1,
    sessionPath: sanitizeAoiAcceptanceDashboardText(input.sessionPath, 160),
    generatedAt: input.now ?? Date.now(),
    answerLabel: 'Why did Aoi judge the situation this way?',
    missionControl,
    currentBrief,
    blindSpots,
    sourceFreshness,
    boundedWorkOrders,
    nextSafeAction,
    whyQuiet,
    pendingApproval,
    replayHealth,
    jarvisReadiness,
    feedbackInbox,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiProposalInspectorSummary(params: {
  proposal: AoiProposal;
  policy?: AoiAutonomyPolicy | null;
  activeProposals?: AoiProposal[];
  includeEvidence?: boolean;
  now?: number;
}): AoiProposalInspectorSummary {
  const policy = params.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const policyResult = checkAoiProposalPolicy({
    policy,
    proposal: params.proposal,
    activeProposals: params.activeProposals,
    now: params.now,
  });
  const suggestedAction = params.proposal.acceptAction?.kind ?? 'none';

  return {
    title: sanitizeAoiProposalDisplayText(params.proposal.title, 140),
    reason: sanitizeAoiProposalDisplayText(params.proposal.reason, 260),
    confidence: params.proposal.confidence,
    risk: params.proposal.risk,
    requiredAutonomyLevel: params.proposal.requiredAutonomyLevel,
    suggestedAction,
    policyAllowed: policyResult.allowed,
    policyReasons: policyResult.reasons,
    evidenceRefs: params.includeEvidence ? params.proposal.evidenceRefs.slice(0, 8) : [],
    safeAlternative: getAoiSafeAlternativeForReasons(params.proposal, policyResult.reasons),
  };
}

export function buildAoiRecoveryPreviewSummary(
  proposal: AoiProposal,
  includeEvidence = false,
): AoiRecoveryPreviewSummary {
  const preview = proposal.recoveryPreview;
  if (!preview) {
    return {
      visible: false,
      failureKind: '',
      rootCauseSummary: '',
      proposedActionLabel: '',
      whyNarrowerOrSafer: '',
      retryLabel: '',
      cooldownLabel: '',
      evidenceRefs: [],
      nonGoals: [],
    };
  }

  const cooldownLabel = preview.cooldownActive
    ? `cooldown active${preview.cooldownUntil ? ` until ${new Date(preview.cooldownUntil).toISOString()}` : ''}`
    : 'cooldown clear';
  return {
    visible: true,
    failureKind: sanitizeAoiProposalDisplayText(preview.failureKind.replace(/_/g, ' '), 80),
    rootCauseSummary: sanitizeAoiProposalDisplayText(preview.rootCauseSummary, 260),
    proposedActionLabel: sanitizeAoiProposalDisplayText(preview.proposedAction.label, 140),
    whyNarrowerOrSafer: sanitizeAoiProposalDisplayText(preview.whyNarrowerOrSafer, 220),
    retryLabel: `${preview.retryCount}/${preview.maxRetryCount} retries used`,
    cooldownLabel: sanitizeAoiProposalDisplayText(cooldownLabel, 120),
    evidenceRefs: includeEvidence ? preview.evidenceRefs.slice(0, 8) : [],
    nonGoals: preview.nonGoals.slice(0, 4).map((item) => sanitizeAoiProposalDisplayText(item, 180)),
  };
}

export function buildAoiMissionPanelSummary(
  mission: AoiMissionState | null | undefined,
  includeEvidence = false,
): AoiMissionPanelSummary {
  if (!mission || mission.status === 'none') {
    return {
      visible: false,
      visibleState: null,
      statusLabel: 'None',
      waitingOnLabel: 'None',
      focusSummary: 'No active mission.',
      nextActionLabel: 'No immediate action.',
      nextActionReason: 'No active mission focus.',
      evidenceCount: 0,
      evidenceRefs: [],
      canPause: false,
      canResume: false,
      canClear: false,
      pauseLabel: 'Pause this goal',
      pauseTitle: 'Pause this goal without deleting evidence.',
      resumeLabel: 'Resume',
      resumeTitle: 'Resume this goal from its saved mission state.',
      showEvidenceLabel: 'Show evidence',
      showEvidenceTitle: 'Show mission evidence and source references.',
    };
  }

  const canPause =
    mission.status === 'active' ||
    mission.status === 'waiting_on_user' ||
    mission.status === 'waiting_on_kira' ||
    mission.status === 'waiting_on_research';
  return {
    visible: true,
    visibleState: getAoiMissionVisibleState(mission),
    statusLabel: mission.status.replace(/_/g, ' '),
    waitingOnLabel: mission.waitingOn.replace(/_/g, ' '),
    focusSummary: sanitizeAoiProposalDisplayText(mission.focusSummary, 160),
    nextActionLabel: sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.label, 160),
    nextActionReason: sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.reason, 220),
    evidenceCount: mission.evidenceRefs.length,
    evidenceRefs: includeEvidence ? mission.evidenceRefs.slice(0, 8) : [],
    canPause,
    canResume: mission.status === 'paused',
    canClear: mission.status !== 'none',
    pauseLabel: 'Pause this goal',
    pauseTitle: 'Pause this goal while keeping evidence and source references.',
    resumeLabel: 'Resume',
    resumeTitle: 'Resume this goal from its saved mission state.',
    showEvidenceLabel: 'Show evidence',
    showEvidenceTitle: 'Show mission evidence and source references.',
  };
}

function formatAoiEnvironmentSourceKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}

function formatAoiEnvironmentSourceOperations(operations: AoiEnvironmentSourceOperation[]): string {
  if (operations.length === 0) {
    return 'No operations';
  }
  return operations.map((operation) => operation.replace(/_/g, ' ')).join(', ');
}

function buildAoiEnvironmentSourceGateReason(
  source: AoiEnvironmentSource,
  registry: AoiEnvironmentSourceRegistry,
  operation: AoiEnvironmentSourceOperation,
): string {
  const policy = checkAoiEnvironmentSourceOperation({
    registry,
    sourceId: source.id,
    operation,
  });
  if (policy.allowed) {
    return 'Allowed for registry metadata only.';
  }
  return policy.reasons
    .map((reason) => reason.replace(/_/g, ' '))
    .map((reason) => sanitizeAoiProposalDisplayText(reason, 120))
    .join(' / ');
}

function buildAoiEnvironmentSourceMetadataScopeLabel(source: AoiEnvironmentSource): string {
  if (source.kind === 'calendar_metadata') {
    return 'Scope: event title, date/time, completion count, and reminder state only.';
  }
  if (source.kind === 'gmail_metadata') {
    return 'Scope: configured/connected state, last sync, unread counts, folders, and label counts only.';
  }
  if (source.kind === 'notes_metadata') {
    return 'Scope: note count, recent modified titles, tags, and pinned state only.';
  }
  if (source.kind === 'browser_context') {
    return 'Scope: explicit page title, host, redacted URL, and user-provided purpose only.';
  }
  return 'Scope: registry metadata and compact source status only.';
}

function buildAoiEnvironmentSourceWillNotReadOrDoLabel(source: AoiEnvironmentSource): string {
  if (source.kind === 'calendar_metadata') {
    return 'Will not read event descriptions or private notes, and will not create/update/delete events.';
  }
  if (source.kind === 'gmail_metadata') {
    return 'Will not read email bodies, snippets, attachments, recipients, or subjects, and will not reply/send/archive/delete/modify email.';
  }
  if (source.kind === 'notes_metadata') {
    return 'Will not read full note bodies or mutate notes; titles and tags are redacted in trace exports.';
  }
  if (source.kind === 'browser_context') {
    return 'Will not scrape page bodies or follow links from context routing alone.';
  }
  return 'Will not mutate this source from context routing alone.';
}

export function buildAoiEnvironmentSourcePanelSummaries(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  options: { operation?: AoiEnvironmentSourceOperation; now?: number } = {},
): AoiEnvironmentSourcePanelSummary[] {
  if (!registry) {
    return [];
  }
  const operation = options.operation ?? 'summarize';
  return registry.sources.map((source) => {
    const personalSource = isAoiPersonalSignalSourceKind(source.kind);
    const gateOperation =
      personalSource && operation === 'summarize' ? 'summarize_counts' : operation;
    const gatedFromEnable =
      !source.enabled && !personalSource && (source.risk === 'high' || source.privateByDefault);
    const consentSummary = source.consentReason
      ? source.consentReason
      : gatedFromEnable || personalSource
        ? 'Explicit target consent is required before Aoi can use this source.'
        : 'No consent reason recorded.';

    return {
      id: source.id,
      label: sanitizeAoiProposalDisplayText(source.label, 96),
      kindLabel: sanitizeAoiProposalDisplayText(formatAoiEnvironmentSourceKind(source.kind), 80),
      enabled: source.enabled,
      enabledLabel: source.enabled ? 'Enabled' : 'Disabled',
      scopeLabel: sanitizeAoiProposalDisplayText(source.scope.replace(/_/g, ' '), 60),
      risk: source.risk,
      riskLabel: source.risk,
      privateLabel: source.privateByDefault ? 'private by default' : 'metadata only',
      operationsLabel: sanitizeAoiProposalDisplayText(
        formatAoiEnvironmentSourceOperations(source.allowedOperations),
        160,
      ),
      quietModeLabel:
        source.quietModeBehavior === 'suppress'
          ? 'Quiet mode suppresses UI'
          : 'Quiet mode records only',
      lastObservedLabel: source.lastObservedAt
        ? new Date(source.lastObservedAt).toLocaleString()
        : 'Not observed',
      lastReviewedLabel: source.lastReviewedAt
        ? new Date(source.lastReviewedAt).toLocaleString()
        : 'Not reviewed',
      consentSummary: sanitizeAoiProposalDisplayText(consentSummary, 180),
      metadataScopeLabel: sanitizeAoiProposalDisplayText(
        buildAoiEnvironmentSourceMetadataScopeLabel(source),
        220,
      ),
      willNotReadOrDoLabel: sanitizeAoiProposalDisplayText(
        buildAoiEnvironmentSourceWillNotReadOrDoLabel(source),
        260,
      ),
      gateReason: buildAoiEnvironmentSourceGateReason(source, registry, gateOperation),
      canToggle: !gatedFromEnable,
      canClear:
        personalSource && Boolean(source.enabled || source.consentReason || source.lastReviewedAt),
      toggleTitle: gatedFromEnable
        ? 'This high-risk or private source needs an explicit target flow before enabling.'
        : personalSource && !source.enabled
          ? 'Enable this personal metadata source after reviewing its exact metadata scope.'
          : source.enabled
            ? 'Disable this environment source.'
            : 'Enable this environment source for metadata-only observation.',
      clearTitle: personalSource
        ? 'Disable this personal source and clear consent, review, and observation state.'
        : 'No clear action is available for this source.',
    };
  });
}

function formatAoiWorkspaceDirtyLabel(snapshot: AoiWorkspaceSnapshot): string {
  const git = snapshot.git;
  if (!git) {
    return 'No git status signal';
  }
  if (!git.isDirty) {
    return 'Working tree clean';
  }
  return `${git.changedFileCount} changed, ${git.stagedFileCount} staged`;
}

function formatAoiWorkspaceValidationLabel(snapshot: AoiWorkspaceSnapshot): string {
  const validation = snapshot.validation;
  if (validation.freshness === 'fresh') {
    return validation.command ? `Fresh: ${validation.command}` : 'Fresh validation evidence';
  }
  if (validation.freshness === 'stale') {
    return 'Validation evidence is stale';
  }
  if (validation.freshness === 'failed') {
    return 'Last validation failed';
  }
  return validation.result === 'passed'
    ? 'Validation recorded without freshness'
    : 'Validation unknown';
}

function getAoiWorkspaceRecommendation(
  snapshot: AoiWorkspaceSnapshot,
): Pick<
  AoiWorkspaceSignalPanelSummary,
  'recommendationLabel' | 'recommendationReason' | 'recommendationTone'
> {
  if (snapshot.validation.freshness === 'failed') {
    return {
      recommendationLabel: 'Prepare a focused validation follow-up.',
      recommendationReason:
        'The last recorded validation failed, so it remains unresolved evidence.',
      recommendationTone: 'recommendation',
    };
  }
  if (snapshot.validation.freshness === 'stale') {
    return {
      recommendationLabel: 'Prepare the next safe validation check.',
      recommendationReason: 'Relevant files changed after the last passed validation.',
      recommendationTone: 'recommendation',
    };
  }
  if (snapshot.git?.branchChanged) {
    return {
      recommendationLabel: 'Review branch drift before continuing.',
      recommendationReason: 'The workspace branch changed since the previous signal.',
      recommendationTone: 'neutral',
    };
  }
  return {
    recommendationLabel: 'No validation follow-up needed.',
    recommendationReason: 'No stale or failed validation signal is attached.',
    recommendationTone: 'neutral',
  };
}

export function buildAoiWorkspaceSignalPanelSummary(
  snapshot: AoiWorkspaceSnapshot | null | undefined,
): AoiWorkspaceSignalPanelSummary {
  if (!snapshot) {
    return {
      visible: false,
      workspaceLabel: 'No workspace signal',
      sourceLabel: 'No source',
      branchLabel: 'No branch signal',
      dirtyLabel: 'No git status signal',
      validationLabel: 'Validation unknown',
      freshness: 'unknown',
      freshnessLabel: 'unknown',
      recommendationLabel: 'No workspace recommendation.',
      recommendationReason: 'Workspace signals are not available yet.',
      recommendationTone: 'neutral',
      changedFileLabels: [],
      evidenceRefs: [],
      warningCount: 0,
    };
  }

  const recommendation = getAoiWorkspaceRecommendation(snapshot);
  const branchLabel = snapshot.git
    ? snapshot.git.branchChanged
      ? `${snapshot.git.previousBranchName ?? 'unknown'} -> ${snapshot.git.branchName}`
      : snapshot.git.branchName
    : 'No branch signal';
  return {
    visible: true,
    workspaceLabel: sanitizeAoiProposalDisplayText(snapshot.workspaceLabel, 80),
    sourceLabel: sanitizeAoiProposalDisplayText(
      snapshot.sourceIds.length > 0 ? snapshot.sourceIds.join(', ') : 'No source',
      120,
    ),
    branchLabel: sanitizeAoiProposalDisplayText(branchLabel, 120),
    dirtyLabel: sanitizeAoiProposalDisplayText(formatAoiWorkspaceDirtyLabel(snapshot), 120),
    validationLabel: sanitizeAoiProposalDisplayText(
      formatAoiWorkspaceValidationLabel(snapshot),
      160,
    ),
    freshness: snapshot.freshness,
    freshnessLabel: sanitizeAoiProposalDisplayText(snapshot.freshness, 40),
    recommendationLabel: sanitizeAoiProposalDisplayText(recommendation.recommendationLabel, 140),
    recommendationReason: sanitizeAoiProposalDisplayText(recommendation.recommendationReason, 220),
    recommendationTone: recommendation.recommendationTone,
    changedFileLabels:
      snapshot.git?.changedFiles
        .slice(0, 4)
        .map((file) => sanitizeAoiProposalDisplayText(file.pathLabel, 100)) ?? [],
    evidenceRefs: snapshot.evidenceRefs
      .slice(0, 8)
      .map((ref) => sanitizeAoiProposalDisplayText(ref, 160)),
    warningCount: snapshot.warnings.length,
  };
}

function formatAoiContextSourceKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}

function buildAoiContextSourcePanelSummary(
  source: AoiContextSourceSummary,
): AoiContextSourcePanelSummary {
  const displayNameLabel = source.displayName || source.label;
  return {
    id: source.id,
    sourceId: source.sourceId,
    label: sanitizeAoiProposalDisplayText(source.label, 120),
    kindLabel: sanitizeAoiProposalDisplayText(formatAoiContextSourceKind(source.kind), 80),
    displayNameLabel: sanitizeAoiProposalDisplayText(displayNameLabel, 96),
    scoreLabel: `${Math.round(source.relevanceScore * 100)}%`,
    freshnessLabel: sanitizeAoiProposalDisplayText(source.freshness, 40),
    confidenceLabel: `${Math.round(source.confidence * 100)}%`,
    redactionLabel:
      source.redactionState === 'redacted'
        ? 'redacted'
        : source.redactionState === 'withheld'
          ? 'withheld'
          : 'clean',
    summary: sanitizeAoiProposalDisplayText(source.summary, 260),
    evidenceRefs: source.evidenceRefs
      .slice(0, 6)
      .map((ref) => sanitizeAoiProposalDisplayText(ref, 180)),
    scoreReasons: source.scoreReasons
      .slice(0, 5)
      .map((reason) => sanitizeAoiProposalDisplayText(reason, 160)),
    wrongEvidenceTitle: `Mark ${displayNameLabel} as wrong evidence for future routing.`,
    wrongTimingTitle: `Mark ${displayNameLabel} as wrong timing for future routing.`,
  };
}

export function buildAoiContextSourcePanelSummaries(
  result: AoiContextRouterResult | null | undefined,
): AoiContextSourcePanelSummary[] {
  if (!result) {
    return [];
  }
  return result.selectedSources.map(buildAoiContextSourcePanelSummary);
}

export function buildAoiMissionResumePrompt(mission: AoiMissionState | null | undefined): string {
  if (!mission || mission.status === 'none' || mission.status === 'completed') {
    return '';
  }
  const refs = [
    mission.sourceRefs.goalRef,
    mission.sourceRefs.proposalRef,
    mission.sourceRefs.kiraWorkRef,
    mission.sourceRefs.researchRunRef,
    mission.lastMeaningfulEventRef,
  ].filter((ref): ref is string => Boolean(ref));
  const refLine = refs.length > 0 ? `- Evidence refs: ${refs.slice(0, 5).join(', ')}.` : '';
  return [
    '',
    '',
    'Aoi Mission Context:',
    `- Where we left off: ${JSON.stringify(sanitizeAoiProposalDisplayText(mission.focusSummary, 160))}.`,
    `- Status: ${mission.status}; waiting on: ${mission.waitingOn}.`,
    `- Next safe action: ${JSON.stringify(sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.label, 160))}.`,
    `- Reason: ${JSON.stringify(sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.reason, 180))}.`,
    refLine,
    '- Treat this as compact context only. Do not execute tools or mutate state from this context without the current user request and normal approval gates.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function summarizeAoiAutonomyProposalCounts(
  activeProposals: AoiProposal[],
  archivedProposals: AoiProposal[],
  status?: AoiAutonomyStatus | null,
): AoiAutonomyProposalCounts {
  const allProposals = [...activeProposals, ...archivedProposals];
  return {
    active:
      status?.activeProposalCount ??
      activeProposals.filter((proposal) => proposal.status === 'active').length,
    dismissed: allProposals.filter((proposal) => proposal.status === 'dismissed').length,
    snoozed:
      status?.snoozedProposalCount ??
      allProposals.filter((proposal) => proposal.status === 'snoozed').length,
    blocked:
      status?.blockedProposalCount ??
      allProposals.filter(
        (proposal) => proposal.status === 'blocked' || Boolean(proposal.blockedReason),
      ).length,
  };
}
