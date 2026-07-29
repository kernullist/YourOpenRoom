import type {
  AoiAppOperationDispatch,
  AoiAutonomyPolicy,
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiAutonomyTickReason,
  AoiAutonomyTickResult,
  AoiAutonomyWakeupBudget,
  AoiAutonomyWakeupReason,
  AoiAutonomyWakeupResult,
  AoiBrowserContextMetadata,
  AoiDeliberationRun,
  AoiCalibrationDimension,
  AoiContextRouterResult,
  AoiContextSourceFeedback,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiFollowThroughDeliveryMode,
  AoiFollowThroughLearningSummary,
  AoiGoal,
  AoiGoalProgressEvent,
  AoiInterestProfile,
  AoiLearningSignalKind,
  AoiMissionDecisionAction,
  AoiMissionState,
  AoiStrategicBrief,
  AoiObservation,
  AoiOperatorTimelineEvent,
  AoiOperatorTimelineEventKind,
  AoiOperatorTimelineSummary,
  AoiOperatorTraceExport,
  AoiOperatorHealthState,
  AoiOpportunity,
  AoiOutcomeLearningSummary,
  AoiOutcomePrivacyState,
  AoiOutcomeSignalKind,
  AoiOutcomeSignalRecord,
  AoiApprovedCommandPolicy,
  AoiPreparedActionPlan,
  AoiPlaybook,
  AoiPlaybookEvidenceKind,
  AoiPlaybookStepRefs,
  AoiFollowThroughEvent,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiProposalFeedbackCategory,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCalibrationInbox,
  AoiProactiveBriefCalibrationTuning,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefFieldMetrics,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFeedbackCategory,
  AoiProactiveTrendAdvisorState,
  AoiProactiveTrendDeliveryEvent,
  AoiProactiveTrendDeliveryEventKind,
  AoiReflection,
  AoiTrustCalibrationReset,
  AoiVoiceRenderDecision,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiCardLang } from './aoiAutonomyCardI18n';
import type { AoiRecordedOutcomeFeedback } from './aoiOutcomeFeedback';
import type { AoiAutonomyEvaluationResult } from './aoiAutonomyEvaluation';
import type { AoiFieldEvent } from './aoiFieldEventLedger';
import type { AoiFieldFeedbackLearningSummary } from './aoiFieldFeedbackLearning';
import type { AoiFieldShadowRecordReport } from './aoiFieldShadowDogfooding';
import type {
  AoiOperatorFlightRecord,
  AoiOperatorFlightRecordInput,
  AoiOperatorFlightRecorderSummary,
  AoiOperatorFlightReplayDraft,
} from './aoiOperatorFlightRecorder';
import type {
  AoiOperatorFeedbackInbox,
  AoiOperatorFeedbackLabelAction,
} from './aoiOperatorFeedbackInbox';
import type { AoiProactiveBriefPanelModel } from './aoiProactiveBriefUi';
import type { AoiShadowDecisionLabel } from './aoiShadowModeEvaluation';

import type { AoiRelationshipMilestone, AoiRelationshipState } from './aoiRelationshipState';

const API_PREFIX = '/api/aoi-autonomy';

export interface AoiAutonomyProposalList {
  sessionPath: string;
  active: AoiProposal[];
  archived: AoiProposal[];
}

export interface AoiOpportunityInboxList {
  sessionPath: string;
  active: AoiOpportunity[];
  archived: AoiOpportunity[];
}

export interface AoiDeliberationRunList {
  sessionPath: string;
  latest: AoiDeliberationRun | null;
  runs: AoiDeliberationRun[];
}

export interface AoiAutonomyDecisionList {
  sessionPath: string;
  decisions: AoiProposalDecision[];
}

export interface AoiAutonomyReflectionList {
  sessionPath: string;
  reflections: AoiReflection[];
}

export interface AoiAutonomyObservationList {
  sessionPath: string;
  observations: AoiObservation[];
}

export interface AoiAutonomyGoalList {
  sessionPath: string;
  active: AoiGoal[];
  archived: AoiGoal[];
  progress: AoiGoalProgressEvent[];
}

export interface AoiAutonomyEvaluationResponse {
  sessionPath: string;
  evaluation: AoiAutonomyEvaluationResult;
}

export interface AoiTrustCalibrationResetInput {
  dimension: AoiCalibrationDimension;
  key: string;
}

export interface AoiTrustCalibrationResetResponse {
  ok: boolean;
  sessionPath: string;
  reset: AoiTrustCalibrationReset;
  evaluation: AoiAutonomyEvaluationResult;
}

export interface AoiAutonomyTimelineResponse {
  sessionPath: string;
  events: AoiOperatorTimelineEvent[];
  summary: AoiOperatorTimelineSummary;
}

export interface AoiAutonomyTraceExportResponse {
  sessionPath: string;
  traceExport: AoiOperatorTraceExport;
  summary: AoiOperatorTimelineSummary;
}

export interface AoiOperatorFlightRecorderResponse {
  ok: boolean;
  sessionPath: string;
  records: AoiOperatorFlightRecord[];
  replayDrafts: AoiOperatorFlightReplayDraft[];
  summary: AoiOperatorFlightRecorderSummary;
}

export interface AoiOperatorFlightRecordResponse extends AoiOperatorFlightRecorderResponse {
  record: AoiOperatorFlightRecord;
}

export interface AoiOperatorFlightReplayDraftResponse extends AoiOperatorFlightRecorderResponse {
  replayDraft: AoiOperatorFlightReplayDraft;
}

export interface AoiOperatorVoiceDecisionRecordResponse {
  ok: boolean;
  sessionPath: string;
  event: AoiOperatorTimelineEvent;
}

export interface AoiAutonomySchedulerResponse {
  sessionPath: string;
  state: AoiAutonomySchedulerState;
}

export interface AoiOperatorHealthResponse {
  sessionPath: string;
  health: AoiOperatorHealthState;
}

export interface AoiAutonomyPlaybookList {
  sessionPath: string;
  active: AoiPlaybook[];
  archived: AoiPlaybook[];
}

export interface AoiPlaybookPrepareInput {
  proposalId?: string;
  goalId?: string;
  title?: string;
  objective?: string;
}

export interface AoiPlaybookEvidenceUpdateInput {
  playbookId: string;
  kind: AoiPlaybookEvidenceKind;
  stepId?: string;
  resultSummary?: string;
  evidenceRefs?: string[];
  refs?: Partial<AoiPlaybookStepRefs>;
  failedReason?: string;
}

export interface AoiPlaybookMutationResponse {
  ok: boolean;
  sessionPath: string;
  playbook: AoiPlaybook;
  active: AoiPlaybook[];
  archived: AoiPlaybook[];
}

export interface AoiAutonomyDashboardSnapshot {
  sessionPath: string;
  status: AoiAutonomyStatus;
  proposals: AoiAutonomyProposalList;
  goals: AoiAutonomyGoalList;
  mission: AoiMissionState | null;
  environmentSources: AoiEnvironmentSourceRegistry;
  workspaceSnapshot: AoiWorkspaceSnapshot | null;
  contextRouter: AoiContextRouterResult | null;
  evaluation: AoiAutonomyEvaluationResult;
  timeline: AoiOperatorTimelineSummary;
  flightRecorder: AoiOperatorFlightRecorderResponse;
  scheduler: AoiAutonomySchedulerState;
  health: AoiOperatorHealthState;
  playbooks: AoiAutonomyPlaybookList;
  opportunities: AoiOpportunityInboxList;
  deliberations: AoiDeliberationRunList;
  proactiveBriefs: AoiProactiveBriefListResponse;
  fieldFeedback: AoiFieldFeedbackResponse;
  outcomeLearning: AoiOutcomeLearningResponse;
}

export interface AoiFieldFeedbackInput {
  decisionRecordId: string;
  decisionId: string;
  fieldEventId?: string;
  opportunityId?: string;
  topicKey?: string;
  sourceKey?: string;
  deliveryMode?: string;
  label: AoiShadowDecisionLabel;
  sourceKinds?: string[];
  note?: string;
  evidenceRefs?: string[];
}

export interface AoiFieldFeedbackResponse {
  ok: boolean;
  sessionPath: string;
  fieldShadowReport: AoiFieldShadowRecordReport | null;
  labelActions: AoiOperatorFeedbackLabelAction[];
  feedbackInbox: AoiOperatorFeedbackInbox;
  learningSummary?: AoiFieldFeedbackLearningSummary;
  followThroughLearning?: AoiFollowThroughLearningSummary;
}

export interface AoiFieldFeedbackRecordResponse extends AoiFieldFeedbackResponse {
  labelAction: AoiOperatorFeedbackLabelAction;
  followThroughEvents: AoiFollowThroughEvent[];
  fieldEvents: AoiFieldEvent[];
  evaluation?: AoiAutonomyEvaluationResult;
}

export interface AoiOutcomeSignalInput {
  id?: string;
  eventId?: string;
  sourceOutcomeId?: string;
  sourceProposalId?: string;
  sourceDecisionId?: string;
  sourceWorkOrderId?: string;
  sourceValidationRef?: string;
  sourceCommitRef?: string;
  sourceChatRef?: string;
  outcomeKind: AoiOutcomeSignalKind;
  signalKind?: AoiLearningSignalKind;
  confidence?: number;
  explicitLabelRef?: string;
  explicitLabel?: string;
  explicitCorrection?: string;
  topicKey?: string;
  sourceKey?: string;
  deliveryMode?: AoiFollowThroughDeliveryMode;
  validationPassed?: boolean;
  evidenceRefs?: string[];
  privacyState?: AoiOutcomePrivacyState;
  createdAt?: number;
}

export interface AoiOutcomeLearningResponse {
  ok: boolean;
  sessionPath: string;
  outcomes: AoiOutcomeSignalRecord[];
  summary: AoiOutcomeLearningSummary;
}

export interface AoiOutcomeSignalRecordResponse extends AoiOutcomeLearningResponse {
  outcome: AoiOutcomeSignalRecord;
  followThroughLearning?: AoiFollowThroughLearningSummary;
  timeline?: AoiOperatorTimelineSummary;
  evaluation?: AoiAutonomyEvaluationResult;
}

export interface AoiProactiveBriefListResponse {
  ok: boolean;
  sessionPath: string;
  candidates: AoiProactiveBriefCandidate[];
  feedback: AoiProactiveBriefFeedback[];
  profile: AoiInterestProfile;
  cooldownState: AoiProactiveBriefCooldownState;
  fieldMetrics?: AoiProactiveBriefFieldMetrics;
  calibrationInbox?: AoiProactiveBriefCalibrationInbox;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning;
  panel?: AoiProactiveBriefPanelModel;
  trendAdvisor?: AoiProactiveTrendAdvisorState;
}

export interface AoiProactiveBriefFeedbackInput {
  briefId: string;
  category: AoiProactiveBriefFeedbackCategory;
  note?: string;
}

export interface AoiProactiveBriefFeedbackResponse extends AoiProactiveBriefListResponse {
  feedbackRecord: AoiProactiveBriefFeedback;
  candidate: AoiProactiveBriefCandidate;
}

export interface AoiProactiveBriefScoutNowResponse extends AoiAutonomyWakeupResult {
  proactiveBriefs: AoiProactiveBriefListResponse;
}

export interface AoiProactiveTrendDeliveryEventInput {
  snapshotId: string;
  kind: AoiProactiveTrendDeliveryEventKind;
}

export interface AoiProactiveTrendDeliveryEventResponse extends AoiProactiveBriefListResponse {
  deliveryEvent: AoiProactiveTrendDeliveryEvent;
}

export interface AoiAutonomyProposalFeedbackResult {
  sessionPath: string;
  decision: AoiProposalDecision;
  evaluation?: AoiAutonomyEvaluationResult;
}

export interface AoiAutonomyPolicyUpdateResult {
  sessionPath: string;
  policy: AoiAutonomyPolicy;
}

export interface AoiEnvironmentSourceListResponse {
  sessionPath: string;
  registry: AoiEnvironmentSourceRegistry;
}

export interface AoiEnvironmentSourceUpdateInput {
  sourceId: string;
  patch: Partial<AoiEnvironmentSource>;
}

export interface AoiEnvironmentSourceUpdateResult {
  sessionPath: string;
  registry: AoiEnvironmentSourceRegistry;
  status?: AoiAutonomyStatus;
}

function serializeAoiEnvironmentSourcePatch(
  patch: Partial<AoiEnvironmentSource>,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...patch };
  for (const key of ['consentReason', 'lastObservedAt', 'lastReviewedAt'] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) {
      serialized[key] = null;
    }
  }
  return serialized;
}

export interface AoiWorkspaceSignalResponse {
  ok: boolean;
  sessionPath: string;
  snapshot: AoiWorkspaceSnapshot | null;
}

export interface AoiContextRouterResponse {
  ok: boolean;
  sessionPath: string;
  context: AoiContextRouterResult | null;
}

export interface AoiBrowserContextInput {
  pageTitle: string;
  url: string;
  purpose?: string;
  capturedAt?: number;
}

export interface AoiBrowserContextResponse {
  ok: boolean;
  sessionPath: string;
  browserContext: AoiBrowserContextMetadata;
  context: AoiContextRouterResult | null;
}

export interface AoiContextSourceFeedbackInput {
  sourceId: string;
  contextSummaryId?: string;
  feedbackCategory: Extract<
    AoiProposalFeedbackCategory,
    'wrong_evidence' | 'wrong_source' | 'wrong_timing' | 'stale' | 'not_useful' | 'too_much'
  >;
  feedbackNote?: string;
  evidenceRefs?: string[];
}

export interface AoiContextSourceFeedbackResponse {
  ok: boolean;
  sessionPath: string;
  feedback: AoiContextSourceFeedback;
  context: AoiContextRouterResult | null;
}

function parseAoiFieldFeedbackPayload(
  payload: Record<string, unknown>,
  sessionPath: string,
): AoiFieldFeedbackResponse {
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;
  return {
    ok: payload.ok === true,
    sessionPath: responseSessionPath,
    fieldShadowReport: isRecord(payload.fieldShadowReport)
      ? (payload.fieldShadowReport as unknown as AoiFieldShadowRecordReport)
      : null,
    labelActions: asArray<AoiOperatorFeedbackLabelAction>(payload.labelActions),
    feedbackInbox: requireRecordField<AoiOperatorFeedbackInbox>(
      payload,
      'feedbackInbox',
      'Aoi field feedback response was malformed.',
    ),
    ...(isRecord(payload.learningSummary)
      ? { learningSummary: payload.learningSummary as unknown as AoiFieldFeedbackLearningSummary }
      : {}),
    ...(isRecord(payload.followThroughLearning)
      ? {
          followThroughLearning:
            payload.followThroughLearning as unknown as AoiFollowThroughLearningSummary,
        }
      : {}),
  };
}

export async function fetchAoiFieldFeedback(
  sessionPath: string,
): Promise<AoiFieldFeedbackResponse> {
  const response = await fetch(`${API_PREFIX}/field-feedback?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi field feedback.');
  return parseAoiFieldFeedbackPayload(payload, sessionPath);
}

export async function recordAoiFieldFeedback(
  sessionPath: string,
  input: AoiFieldFeedbackInput,
): Promise<AoiFieldFeedbackRecordResponse> {
  const response = await fetch(`${API_PREFIX}/field-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      decisionRecordId: input.decisionRecordId,
      decisionId: input.decisionId,
      fieldEventId: input.fieldEventId,
      opportunityId: input.opportunityId,
      topicKey: input.topicKey,
      sourceKey: input.sourceKey,
      deliveryMode: input.deliveryMode,
      label: input.label,
      sourceKinds: input.sourceKinds,
      note: input.note,
      evidenceRefs: input.evidenceRefs,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi field feedback.');
  return {
    ...parseAoiFieldFeedbackPayload(payload, sessionPath),
    labelAction: requireRecordField<AoiOperatorFeedbackLabelAction>(
      payload,
      'labelAction',
      'Aoi field feedback record response was malformed.',
    ),
    followThroughEvents: asArray<AoiFollowThroughEvent>(payload.followThroughEvents),
    fieldEvents: asArray<AoiFieldEvent>(payload.fieldEvents),
    ...(isRecord(payload.evaluation)
      ? { evaluation: payload.evaluation as unknown as AoiAutonomyEvaluationResult }
      : {}),
  };
}

function parseAoiOutcomeLearningPayload(
  payload: Record<string, unknown>,
  sessionPath: string,
): AoiOutcomeLearningResponse {
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;
  return {
    ok: payload.ok === true,
    sessionPath: responseSessionPath,
    outcomes: asArray<AoiOutcomeSignalRecord>(payload.outcomes),
    summary: requireRecordField<AoiOutcomeLearningSummary>(
      payload,
      'summary',
      'Aoi outcome learning response was malformed.',
    ),
  };
}

export async function fetchAoiOutcomeLearning(
  sessionPath: string,
): Promise<AoiOutcomeLearningResponse> {
  const response = await fetch(`${API_PREFIX}/outcomes?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi outcome learning.');
  return parseAoiOutcomeLearningPayload(payload, sessionPath);
}

export async function recordAoiOutcomeSignal(
  sessionPath: string,
  input: AoiOutcomeSignalInput,
): Promise<AoiOutcomeSignalRecordResponse> {
  const response = await fetch(`${API_PREFIX}/outcomes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      id: input.id,
      eventId: input.eventId,
      sourceOutcomeId: input.sourceOutcomeId,
      sourceProposalId: input.sourceProposalId,
      sourceDecisionId: input.sourceDecisionId,
      sourceWorkOrderId: input.sourceWorkOrderId,
      sourceValidationRef: input.sourceValidationRef,
      sourceCommitRef: input.sourceCommitRef,
      sourceChatRef: input.sourceChatRef,
      outcomeKind: input.outcomeKind,
      signalKind: input.signalKind,
      confidence: input.confidence,
      explicitLabelRef: input.explicitLabelRef,
      explicitLabel: input.explicitLabel,
      explicitCorrection: input.explicitCorrection,
      topicKey: input.topicKey,
      sourceKey: input.sourceKey,
      deliveryMode: input.deliveryMode,
      validationPassed: input.validationPassed,
      evidenceRefs: input.evidenceRefs,
      privacyState: input.privacyState,
      createdAt: input.createdAt,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi outcome signal.');
  return {
    ...parseAoiOutcomeLearningPayload(payload, sessionPath),
    outcome: requireRecordField<AoiOutcomeSignalRecord>(
      payload,
      'outcome',
      'Aoi outcome signal record response was malformed.',
    ),
    ...(isRecord(payload.followThroughLearning)
      ? {
          followThroughLearning:
            payload.followThroughLearning as unknown as AoiFollowThroughLearningSummary,
        }
      : {}),
    ...(isRecord(payload.timeline)
      ? { timeline: payload.timeline as unknown as AoiOperatorTimelineSummary }
      : {}),
    ...(isRecord(payload.evaluation)
      ? { evaluation: payload.evaluation as unknown as AoiAutonomyEvaluationResult }
      : {}),
  };
}

export async function recordAoiOperatorOutcomeFeedback(
  sessionPath: string,
  input: { userMessage: string; sourceChatRef: string },
): Promise<AoiRecordedOutcomeFeedback> {
  const response = await fetch(`${API_PREFIX}/outcomes/operator-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      userMessage: input.userMessage,
      sourceChatRef: input.sourceChatRef,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi operator outcome feedback.');
  return requireRecordField<AoiRecordedOutcomeFeedback>(
    payload,
    'record',
    'Aoi operator outcome feedback response was malformed.',
  );
}

export interface AoiAutonomyProposalDecisionResult {
  sessionPath: string;
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  goal?: AoiGoal | null;
  active: AoiProposal[];
  archived: AoiProposal[];
  executed: false;
}

export interface AoiAutonomyGoalDecisionResult {
  sessionPath: string;
  goal: AoiGoal | null;
  active: AoiGoal[];
  archived: AoiGoal[];
  proposal?: AoiProposal;
  decision?: AoiProposalDecision;
  status?: AoiAutonomyStatus;
}

export interface AoiAutonomyGoalDecisionInput {
  action: 'accept' | 'pause' | 'resume' | 'abandon' | 'complete' | 'block';
  goalId?: string;
  proposalId?: string;
  reason?: string;
  evidenceRefs?: string[];
  userConfirmed?: boolean;
}

export interface AoiAutonomyMissionResponse {
  sessionPath: string;
  mission: AoiMissionState | null;
  status?: AoiAutonomyStatus;
}

export interface AoiAutonomyMissionDecisionInput {
  action: AoiMissionDecisionAction;
  reason?: string;
  evidenceRefs?: string[];
}

export interface AoiAutonomyProposalDecisionInput {
  proposalId: string;
  action: AoiProposalDecisionAction;
  reason?: string;
  feedbackCategory?: AoiProposalFeedbackCategory;
  feedbackNote?: string;
  snoozeMs?: number;
}

export interface AoiAutonomyProposalFeedbackInput {
  decisionId: string;
  feedbackCategory: AoiProposalFeedbackCategory;
  feedbackNote?: string;
}

export interface AoiAutonomyProposalExecutionResult {
  ok: boolean;
  sessionPath: string;
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  status: AoiAutonomyStatus;
  executed: boolean;
  outcome: 'executed' | 'blocked' | 'failed';
  reasons: string[];
  result?: Record<string, unknown>;
}

export interface AoiAutonomyProposalPreviewResult {
  ok: boolean;
  sessionPath: string;
  proposal: AoiProposal;
  status: AoiAutonomyStatus;
  previewed: boolean;
  outcome: 'previewed' | 'blocked';
  reasons: string[];
  preparedActionPlan?: AoiPreparedActionPlan;
  approvedCommandPolicy?: AoiApprovedCommandPolicy;
  result?: Record<string, unknown> & {
    preparedActionPlan?: AoiPreparedActionPlan;
    approvedCommandPolicy?: AoiApprovedCommandPolicy;
    commandResult?: unknown;
    preview?: Record<string, unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  return fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function readJsonRecord(
  response: Response,
  fallbackError: string,
): Promise<Record<string, unknown>> {
  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, fallbackError));
  }

  if (!isRecord(payload)) {
    throw new Error(fallbackError);
  }

  return payload;
}

function requireRecordField<T>(
  payload: Record<string, unknown>,
  field: string,
  fallbackError: string,
): T {
  const value = payload[field];
  if (!isRecord(value)) {
    throw new Error(fallbackError);
  }
  return value as T;
}

function sessionQuery(sessionPath: string): string {
  return `sessionPath=${encodeURIComponent(sessionPath)}`;
}

export async function fetchAoiAutonomyStatus(sessionPath: string): Promise<AoiAutonomyStatus> {
  const response = await fetch(`${API_PREFIX}/status?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy status.');
  return requireRecordField<AoiAutonomyStatus>(
    payload,
    'status',
    'Aoi autonomy status response was malformed.',
  );
}

// R2.1/R2.2 relationship record. The store module touches node fs, so only its
// TYPE is imported here (erased at build time) and all access goes over the
// routes -- a value import would break the client bundle.
export async function fetchAoiRelationshipState(
  sessionPath: string,
): Promise<AoiRelationshipState | null> {
  const response = await fetch(`${API_PREFIX}/relationship?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi relationship state.');
  const relationship = payload.relationship;
  return relationship ? (relationship as AoiRelationshipState) : null;
}

export interface AoiRelationshipSessionOpenResult {
  relationship: AoiRelationshipState | null;
  // R3.3: milestones crossed by THIS open. Only these are worth mentioning --
  // the full list is history, not news.
  newMilestones: AoiRelationshipMilestone[];
}

// Marks a session as opened: creates the record on a first-ever open and
// increments the session count only past the store's gap floor.
export async function reportAoiRelationshipSessionOpen(
  sessionPath: string,
): Promise<AoiRelationshipSessionOpenResult> {
  const response = await fetch(`${API_PREFIX}/relationship/session-open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath }),
  });
  const payload = await readJsonRecord(response, 'Failed to record an Aoi session open.');
  const relationship = payload.relationship;
  return {
    relationship: relationship ? (relationship as AoiRelationshipState) : null,
    newMilestones: Array.isArray(payload.newMilestones)
      ? (payload.newMilestones as AoiRelationshipMilestone[])
      : [],
  };
}

// Stores what this session was about and which threads are still open, so the
// next open can pick them up. The server redacts and caps the free text.
export async function reportAoiRelationshipSessionSummary(
  sessionPath: string,
  input: { summary?: string; openThreads?: Array<{ title: string }> },
): Promise<AoiRelationshipState | null> {
  const response = await fetch(`${API_PREFIX}/relationship/session-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.openThreads ? { openThreads: input.openThreads } : {}),
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record an Aoi session summary.');
  const relationship = payload.relationship;
  return relationship ? (relationship as AoiRelationshipState) : null;
}

// Marks a thread as raised so Aoi does not ask about it again.
export async function reportAoiRelationshipThreadAsked(
  sessionPath: string,
  threadId: string,
): Promise<AoiRelationshipState | null> {
  const response = await fetch(`${API_PREFIX}/relationship/thread-asked`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath, threadId }),
  });
  const payload = await readJsonRecord(response, 'Failed to record an Aoi thread follow-up.');
  const relationship = payload.relationship;
  return relationship ? (relationship as AoiRelationshipState) : null;
}

export async function fetchAoiAutonomyProposals(
  sessionPath: string,
  includeArchived = true,
): Promise<AoiAutonomyProposalList> {
  const response = await fetch(
    `${API_PREFIX}/proposals?${sessionQuery(sessionPath)}&includeArchived=${includeArchived}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy proposals.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    active: asArray<AoiProposal>(payload.active),
    archived: asArray<AoiProposal>(payload.archived),
  };
}

export async function fetchAoiOpportunityInbox(
  sessionPath: string,
  includeArchived = true,
): Promise<AoiOpportunityInboxList> {
  const response = await fetch(
    `${API_PREFIX}/opportunities?${sessionQuery(sessionPath)}&includeArchived=${includeArchived}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi opportunity inbox.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    active: asArray<AoiOpportunity>(payload.active),
    archived: asArray<AoiOpportunity>(payload.archived),
  };
}

export async function fetchAoiDeliberationRuns(
  sessionPath: string,
  limit = 20,
): Promise<AoiDeliberationRunList> {
  const response = await fetch(
    `${API_PREFIX}/deliberations?${sessionQuery(sessionPath)}&limit=${encodeURIComponent(String(limit))}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi deliberation runs.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    latest: isRecord(payload.latest) ? (payload.latest as unknown as AoiDeliberationRun) : null,
    runs: asArray<AoiDeliberationRun>(payload.runs),
  };
}

export async function fetchAoiProposalDecisions(
  sessionPath: string,
  limit = 50,
): Promise<AoiAutonomyDecisionList> {
  const response = await fetch(
    `${API_PREFIX}/decisions?${sessionQuery(sessionPath)}&limit=${encodeURIComponent(String(limit))}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi proposal decisions.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    decisions: asArray<AoiProposalDecision>(payload.decisions),
  };
}

export async function fetchAoiAutonomyReflections(
  sessionPath: string,
): Promise<AoiAutonomyReflectionList> {
  const response = await fetch(`${API_PREFIX}/reflections?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy reflections.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    reflections: asArray<AoiReflection>(payload.reflections),
  };
}

export async function fetchAoiAutonomyObservations(
  sessionPath: string,
  limit = 50,
): Promise<AoiAutonomyObservationList> {
  const response = await fetch(
    `${API_PREFIX}/observations?${sessionQuery(sessionPath)}&limit=${encodeURIComponent(String(limit))}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy observations.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    observations: asArray<AoiObservation>(payload.observations),
  };
}

export async function fetchAoiAutonomyGoals(sessionPath: string): Promise<AoiAutonomyGoalList> {
  const response = await fetch(`${API_PREFIX}/goals?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy goals.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    active: asArray<AoiGoal>(payload.active),
    archived: asArray<AoiGoal>(payload.archived),
    progress: asArray<AoiGoalProgressEvent>(payload.progress),
  };
}

export async function fetchAoiAutonomyEvaluation(
  sessionPath: string,
): Promise<AoiAutonomyEvaluationResponse> {
  const response = await fetch(`${API_PREFIX}/evaluation?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy evaluation.');
  const evaluation = requireRecordField<AoiAutonomyEvaluationResult>(
    payload,
    'evaluation',
    'Aoi autonomy evaluation response was malformed.',
  );

  return {
    sessionPath: evaluation.sessionPath || sessionPath,
    evaluation,
  };
}

export async function fetchAoiOperatorHealth(
  sessionPath: string,
): Promise<AoiOperatorHealthResponse> {
  const response = await fetch(`${API_PREFIX}/health?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi operator health.');
  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    health: requireRecordField<AoiOperatorHealthState>(
      payload,
      'health',
      'Aoi operator health response was malformed.',
    ),
  };
}

function parseAoiProactiveBriefListPayload(
  payload: Record<string, unknown>,
  sessionPath: string,
): AoiProactiveBriefListResponse {
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;
  const profile = requireRecordField<AoiInterestProfile>(
    payload,
    'profile',
    'Aoi proactive brief profile response was malformed.',
  );
  const cooldownState = requireRecordField<AoiProactiveBriefCooldownState>(
    payload,
    'cooldownState',
    'Aoi proactive brief cooldown response was malformed.',
  );
  return {
    ok: payload.ok === true,
    sessionPath: responseSessionPath,
    candidates: asArray<AoiProactiveBriefCandidate>(payload.candidates),
    feedback: asArray<AoiProactiveBriefFeedback>(payload.feedback),
    profile,
    cooldownState,
    ...(isRecord(payload.fieldMetrics)
      ? { fieldMetrics: payload.fieldMetrics as unknown as AoiProactiveBriefFieldMetrics }
      : {}),
    ...(isRecord(payload.calibrationInbox)
      ? {
          calibrationInbox:
            payload.calibrationInbox as unknown as AoiProactiveBriefCalibrationInbox,
        }
      : {}),
    ...(isRecord(payload.calibrationTuning)
      ? {
          calibrationTuning:
            payload.calibrationTuning as unknown as AoiProactiveBriefCalibrationTuning,
        }
      : {}),
    ...(isRecord(payload.panel)
      ? { panel: payload.panel as unknown as AoiProactiveBriefPanelModel }
      : {}),
    ...(isRecord(payload.trendAdvisor)
      ? { trendAdvisor: payload.trendAdvisor as unknown as AoiProactiveTrendAdvisorState }
      : {}),
  };
}

export async function fetchAoiProactiveBriefs(
  sessionPath: string,
): Promise<AoiProactiveBriefListResponse> {
  const response = await fetch(`${API_PREFIX}/proactive-briefs?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi proactive briefs.');
  return parseAoiProactiveBriefListPayload(payload, sessionPath);
}

export async function recordAoiProactiveBriefFeedback(
  sessionPath: string,
  input: AoiProactiveBriefFeedbackInput,
): Promise<AoiProactiveBriefFeedbackResponse> {
  const response = await fetch(`${API_PREFIX}/proactive-briefs/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      briefId: input.briefId,
      category: input.category,
      note: input.note,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi proactive brief feedback.');
  return {
    ...parseAoiProactiveBriefListPayload(payload, sessionPath),
    feedbackRecord: requireRecordField<AoiProactiveBriefFeedback>(
      payload,
      'feedbackRecord',
      'Aoi proactive brief feedback response was malformed.',
    ),
    candidate: requireRecordField<AoiProactiveBriefCandidate>(
      payload,
      'candidate',
      'Aoi proactive brief candidate response was malformed.',
    ),
  };
}

export async function recordAoiProactiveTrendDeliveryEvent(
  sessionPath: string,
  input: AoiProactiveTrendDeliveryEventInput,
): Promise<AoiProactiveTrendDeliveryEventResponse> {
  const response = await fetch(`${API_PREFIX}/proactive-briefs/trend-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      snapshotId: input.snapshotId,
      kind: input.kind,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi proactive trend delivery.');
  return {
    ...parseAoiProactiveBriefListPayload(payload, sessionPath),
    deliveryEvent: requireRecordField<AoiProactiveTrendDeliveryEvent>(
      payload,
      'deliveryEvent',
      'Aoi proactive trend delivery response was malformed.',
    ),
  };
}

export async function runAoiProactiveBriefScoutNow(params: {
  sessionPath: string;
  topicId?: string;
  quietMode?: boolean;
}): Promise<AoiProactiveBriefScoutNowResponse> {
  const response = await fetch(`${API_PREFIX}/proactive-briefs/scout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      topicId: params.topicId,
      mode: 'quick',
      quietMode: params.quietMode,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to run Aoi proactive brief scout.');
  const hasWakeupResultPayload =
    isRecord(payload.record) &&
    isRecord(payload.state) &&
    isRecord(payload.status) &&
    isRecord(payload.proactiveBriefs);
  if (payload.ok !== true && !hasWakeupResultPayload) {
    throw new Error(getErrorMessage(payload, 'Aoi proactive brief scout did not complete.'));
  }
  return {
    ...(payload as unknown as AoiAutonomyWakeupResult),
    proactiveBriefs: parseAoiProactiveBriefListPayload(
      requireRecordField<Record<string, unknown>>(
        payload,
        'proactiveBriefs',
        'Aoi proactive brief scout response was malformed.',
      ),
      params.sessionPath,
    ),
  };
}

export async function resetAoiProactiveBriefCooldown(params: {
  sessionPath: string;
  topicId?: string;
}): Promise<AoiProactiveBriefListResponse> {
  const response = await fetch(`${API_PREFIX}/proactive-briefs/cooldown/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      topicId: params.topicId,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to reset Aoi proactive brief cooldown.');
  if (payload.ok !== true) {
    throw new Error(getErrorMessage(payload, 'Aoi proactive brief cooldown reset was blocked.'));
  }
  return parseAoiProactiveBriefListPayload(payload, params.sessionPath);
}

export async function fetchAoiPlaybooks(
  sessionPath: string,
  includeArchived = true,
): Promise<AoiAutonomyPlaybookList> {
  const response = await fetch(
    `${API_PREFIX}/playbooks?${sessionQuery(sessionPath)}&includeArchived=${includeArchived}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi playbooks.');
  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    active: asArray<AoiPlaybook>(payload.active),
    archived: asArray<AoiPlaybook>(payload.archived),
  };
}

export async function prepareAoiPlaybookPreview(
  sessionPath: string,
  input: AoiPlaybookPrepareInput = {},
): Promise<AoiPlaybookMutationResponse> {
  const response = await fetch(`${API_PREFIX}/playbooks/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      proposalId: input.proposalId,
      goalId: input.goalId,
      title: input.title,
      objective: input.objective,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to prepare Aoi playbook.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    playbook: requireRecordField<AoiPlaybook>(
      payload,
      'playbook',
      'Aoi playbook prepare response was malformed.',
    ),
    active: asArray<AoiPlaybook>(payload.active),
    archived: asArray<AoiPlaybook>(payload.archived),
  };
}

export async function updateAoiPlaybookProgress(
  sessionPath: string,
  input: AoiPlaybookEvidenceUpdateInput,
): Promise<AoiPlaybookMutationResponse> {
  const response = await fetch(`${API_PREFIX}/playbooks/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      playbookId: input.playbookId,
      kind: input.kind,
      stepId: input.stepId,
      resultSummary: input.resultSummary,
      evidenceRefs: input.evidenceRefs,
      refs: input.refs,
      failedReason: input.failedReason,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to update Aoi playbook.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    playbook: requireRecordField<AoiPlaybook>(
      payload,
      'playbook',
      'Aoi playbook update response was malformed.',
    ),
    active: asArray<AoiPlaybook>(payload.active),
    archived: asArray<AoiPlaybook>(payload.archived),
  };
}

export async function resetAoiTrustCalibrationCategory(
  sessionPath: string,
  input: AoiTrustCalibrationResetInput,
): Promise<AoiTrustCalibrationResetResponse> {
  const response = await fetch(`${API_PREFIX}/calibration/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      dimension: input.dimension,
      key: input.key,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to reset Aoi trust calibration.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    reset: requireRecordField<AoiTrustCalibrationReset>(
      payload,
      'reset',
      'Aoi trust calibration reset response was malformed.',
    ),
    evaluation: requireRecordField<AoiAutonomyEvaluationResult>(
      payload,
      'evaluation',
      'Aoi trust calibration reset response was malformed.',
    ),
  };
}

export async function fetchAoiMissionState(
  sessionPath: string,
): Promise<AoiAutonomyMissionResponse> {
  const response = await fetch(`${API_PREFIX}/mission?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi mission state.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    mission: isRecord(payload.mission) ? (payload.mission as unknown as AoiMissionState) : null,
    status: isRecord(payload.status) ? (payload.status as unknown as AoiAutonomyStatus) : undefined,
  };
}

export async function fetchAoiStrategicBrief(
  sessionPath: string,
): Promise<AoiStrategicBrief | null> {
  const response = await fetch(`${API_PREFIX}/strategic-brief?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi strategic brief.');
  return isRecord(payload.brief) ? (payload.brief as unknown as AoiStrategicBrief) : null;
}

// P2/B3-1 c3 client bridge: poll the pending app-operation dispatches the autonomy loop
// queued (GET), and report each agent->app dispatch result back (POST). The bridge
// re-checks the content-addressed approval before dispatching; these calls only move a
// queued record that already passed the L5 + approval gate + the user's acceptance.
export async function fetchAoiAppOperationDispatches(
  sessionPath: string,
): Promise<AoiAppOperationDispatch[]> {
  const response = await fetch(`${API_PREFIX}/app-operation-dispatch?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi app-operation dispatches.');
  return Array.isArray(payload.pending)
    ? (payload.pending as unknown as AoiAppOperationDispatch[])
    : [];
}

export interface AoiAppOperationDispatchReportInput {
  id: string;
  status: 'dispatched' | 'failed';
  actionResult?: string;
  failureReason?: string;
}

export async function reportAoiAppOperationDispatchResult(
  sessionPath: string,
  input: AoiAppOperationDispatchReportInput,
): Promise<AoiAppOperationDispatch | null> {
  const response = await fetch(`${API_PREFIX}/app-operation-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      id: input.id,
      status: input.status,
      actionResult: input.actionResult,
      failureReason: input.failureReason,
    }),
  });
  const payload = await readJsonRecord(
    response,
    'Failed to report Aoi app-operation dispatch result.',
  );
  return isRecord(payload.dispatch)
    ? (payload.dispatch as unknown as AoiAppOperationDispatch)
    : null;
}

export async function fetchAoiEnvironmentSources(
  sessionPath: string,
): Promise<AoiEnvironmentSourceListResponse> {
  const response = await fetch(`${API_PREFIX}/sources?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi environment sources.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    registry: requireRecordField<AoiEnvironmentSourceRegistry>(
      payload,
      'registry',
      'Aoi environment source response was malformed.',
    ),
  };
}

export async function fetchAoiWorkspaceSnapshot(
  sessionPath: string,
  options: { collect?: boolean } = {},
): Promise<AoiWorkspaceSignalResponse> {
  const collectQuery =
    typeof options.collect === 'boolean' ? `&collect=${String(options.collect)}` : '';
  const response = await fetch(
    `${API_PREFIX}/workspace?${sessionQuery(sessionPath)}${collectQuery}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi workspace signal.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    ok: payload.ok === true,
    sessionPath: responseSessionPath,
    snapshot: isRecord(payload.snapshot)
      ? (payload.snapshot as unknown as AoiWorkspaceSnapshot)
      : null,
  };
}

export async function fetchAoiContextRouter(
  sessionPath: string,
  options: { latestUserMessage?: string } = {},
): Promise<AoiContextRouterResponse> {
  const messageQuery =
    typeof options.latestUserMessage === 'string'
      ? `&latestUserMessage=${encodeURIComponent(options.latestUserMessage)}`
      : '';
  const response = await fetch(`${API_PREFIX}/context?${sessionQuery(sessionPath)}${messageQuery}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi context router.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    ok: payload.ok === true,
    sessionPath: responseSessionPath,
    context: isRecord(payload.context)
      ? (payload.context as unknown as AoiContextRouterResult)
      : null,
  };
}

export async function fetchAoiAutonomyTimeline(
  sessionPath: string,
  options: { limit?: number } = {},
): Promise<AoiAutonomyTimelineResponse> {
  const limitQuery =
    typeof options.limit === 'number' ? `&limit=${encodeURIComponent(String(options.limit))}` : '';
  const response = await fetch(`${API_PREFIX}/timeline?${sessionQuery(sessionPath)}${limitQuery}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi operator timeline.');
  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    events: Array.isArray(payload.events) ? (payload.events as AoiOperatorTimelineEvent[]) : [],
    summary: requireRecordField<AoiOperatorTimelineSummary>(
      payload,
      'summary',
      'Aoi timeline response was malformed.',
    ),
  };
}

export async function exportAoiAutonomyTrace(
  sessionPath: string,
  options: { limit?: number; eventKinds?: AoiOperatorTimelineEventKind[] } = {},
): Promise<AoiAutonomyTraceExportResponse> {
  const response = await fetch(`${API_PREFIX}/timeline/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      limit: options.limit,
      eventKinds: options.eventKinds,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to export Aoi operator timeline.');
  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    traceExport: requireRecordField<AoiOperatorTraceExport>(
      payload,
      'traceExport',
      'Aoi trace export response was malformed.',
    ),
    summary: requireRecordField<AoiOperatorTimelineSummary>(
      payload,
      'summary',
      'Aoi trace export summary was malformed.',
    ),
  };
}

function parseAoiOperatorFlightRecorderPayload(
  payload: Record<string, unknown>,
  sessionPath: string,
): AoiOperatorFlightRecorderResponse {
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;
  return {
    ok: payload.ok === true,
    sessionPath: responseSessionPath,
    records: asArray<AoiOperatorFlightRecord>(payload.records),
    replayDrafts: asArray<AoiOperatorFlightReplayDraft>(payload.replayDrafts),
    summary: requireRecordField<AoiOperatorFlightRecorderSummary>(
      payload,
      'summary',
      'Aoi operator flight recorder response was malformed.',
    ),
  };
}

export async function fetchAoiOperatorFlightRecorder(
  sessionPath: string,
  options: { limit?: number } = {},
): Promise<AoiOperatorFlightRecorderResponse> {
  const limitQuery =
    typeof options.limit === 'number' ? `&limit=${encodeURIComponent(String(options.limit))}` : '';
  const response = await fetch(
    `${API_PREFIX}/flight-recorder?${sessionQuery(sessionPath)}${limitQuery}`,
  );
  const payload = await readJsonRecord(response, 'Failed to load Aoi operator flight recorder.');
  return parseAoiOperatorFlightRecorderPayload(payload, sessionPath);
}

export async function recordAoiOperatorFlightDecision(
  sessionPath: string,
  input: AoiOperatorFlightRecordInput,
): Promise<AoiOperatorFlightRecordResponse> {
  const response = await fetch(`${API_PREFIX}/flight-recorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...input,
      sessionPath,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi operator flight decision.');
  return {
    ...parseAoiOperatorFlightRecorderPayload(payload, sessionPath),
    record: requireRecordField<AoiOperatorFlightRecord>(
      payload,
      'record',
      'Aoi operator flight record response was malformed.',
    ),
  };
}

export async function createAoiOperatorFlightReplayDraft(params: {
  sessionPath: string;
  recordId?: string;
}): Promise<AoiOperatorFlightReplayDraftResponse> {
  const response = await fetch(`${API_PREFIX}/flight-recorder/replay-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      recordId: params.recordId,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to create Aoi flight replay draft.');
  return {
    ...parseAoiOperatorFlightRecorderPayload(payload, params.sessionPath),
    replayDraft: requireRecordField<AoiOperatorFlightReplayDraft>(
      payload,
      'replayDraft',
      'Aoi flight replay draft response was malformed.',
    ),
  };
}

export async function recordAoiOperatorVoiceDecision(
  sessionPath: string,
  decision: AoiVoiceRenderDecision,
): Promise<AoiOperatorVoiceDecisionRecordResponse> {
  const response = await fetch(`${API_PREFIX}/voice/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      decision,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi operator voice decision.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    event: requireRecordField<AoiOperatorTimelineEvent>(
      payload,
      'event',
      'Aoi operator voice decision response was malformed.',
    ),
  };
}

export async function fetchAoiAutonomyScheduler(
  sessionPath: string,
): Promise<AoiAutonomySchedulerResponse> {
  const response = await fetch(`${API_PREFIX}/scheduler?${sessionQuery(sessionPath)}`);
  const payload = await readJsonRecord(response, 'Failed to load Aoi autonomy scheduler.');
  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    state: requireRecordField<AoiAutonomySchedulerState>(
      payload,
      'state',
      'Aoi scheduler response was malformed.',
    ),
  };
}

export async function runAoiAutonomyWakeup(params: {
  sessionPath: string;
  reason: AoiAutonomyWakeupReason;
  latestUserMessage?: string;
  llmConfig?: unknown;
  sourceIds?: string[];
  budget?: Partial<AoiAutonomyWakeupBudget>;
  quietMode?: boolean;
  userIdleMs?: number;
  language?: AoiCardLang;
}): Promise<AoiAutonomyWakeupResult> {
  const response = await fetch(`${API_PREFIX}/wakeup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      reason: params.reason,
      latestUserMessage: params.latestUserMessage,
      llmConfig: params.llmConfig,
      sourceIds: params.sourceIds,
      budget: params.budget,
      quietMode: params.quietMode,
      userIdleMs: params.userIdleMs,
      language: params.language,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to run Aoi autonomy wakeup.');
  const hasWakeupResultPayload =
    isRecord(payload.record) && isRecord(payload.state) && isRecord(payload.status);
  if (payload.ok !== true && !hasWakeupResultPayload) {
    throw new Error(getErrorMessage(payload, 'Aoi autonomy wakeup did not complete.'));
  }
  return payload as unknown as AoiAutonomyWakeupResult;
}

export function runAoiAutonomySessionOpenWakeup(params: {
  sessionPath: string;
  latestUserMessage?: string;
  llmConfig?: unknown;
  quietMode?: boolean;
  userIdleMs?: number;
  language?: AoiCardLang;
}): Promise<AoiAutonomyWakeupResult> {
  return runAoiAutonomyWakeup({
    ...params,
    reason: typeof params.userIdleMs === 'number' ? 'user_return_idle' : 'session_open',
    budget: {
      maxSchedulerRuntimeMs: 150000,
      maxBackgroundTickRuntimeMs: 120000,
      maxSourceCount: 3,
      maxGeneratedProposalCount: 2,
      wakeupCooldownMs: 60000,
    },
  });
}

export function runAoiAutonomyManualWakeup(params: {
  sessionPath: string;
  latestUserMessage?: string;
  llmConfig?: unknown;
  sourceIds?: string[];
  budget?: Partial<AoiAutonomyWakeupBudget>;
  quietMode?: boolean;
  language?: AoiCardLang;
}): Promise<AoiAutonomyWakeupResult> {
  return runAoiAutonomyWakeup({
    ...params,
    reason: 'manual_refresh',
    budget: {
      maxSchedulerRuntimeMs: 150000,
      maxBackgroundTickRuntimeMs: 120000,
      maxSourceCount: 3,
      maxGeneratedProposalCount: 2,
      wakeupCooldownMs: 0,
      ...params.budget,
    },
  });
}

export async function recordAoiBrowserContext(
  sessionPath: string,
  input: AoiBrowserContextInput,
): Promise<AoiBrowserContextResponse> {
  const response = await fetch(`${API_PREFIX}/context/browser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      pageTitle: input.pageTitle,
      url: input.url,
      purpose: input.purpose,
      capturedAt: input.capturedAt,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi browser context.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    browserContext: requireRecordField<AoiBrowserContextMetadata>(
      payload,
      'browserContext',
      'Aoi browser context response was malformed.',
    ),
    context: isRecord(payload.context)
      ? (payload.context as unknown as AoiContextRouterResult)
      : null,
  };
}

export async function recordAoiContextSourceFeedback(
  sessionPath: string,
  input: AoiContextSourceFeedbackInput,
): Promise<AoiContextSourceFeedbackResponse> {
  const response = await fetch(`${API_PREFIX}/context/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      sourceId: input.sourceId,
      contextSummaryId: input.contextSummaryId,
      feedbackCategory: input.feedbackCategory,
      feedbackNote: input.feedbackNote,
      evidenceRefs: input.evidenceRefs,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi context feedback.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    feedback: requireRecordField<AoiContextSourceFeedback>(
      payload,
      'feedback',
      'Aoi context feedback response was malformed.',
    ),
    context: isRecord(payload.context)
      ? (payload.context as unknown as AoiContextRouterResult)
      : null,
  };
}

export interface AoiActivityEventRecordInput {
  kind: 'app_opened' | 'app_closed' | 'app_focused' | 'app_action' | 'chat_turn';
  appId?: string;
  actionType?: string;
  observedAt?: number;
}

export interface AoiActivityEventRecordResponse {
  ok: boolean;
  sessionPath: string;
}

// SA1.3: metadata-only live-activity capture. The server route re-enforces the
// app-activity consent gate fail-closed (403 while dark) -- callers treat this
// as best-effort and must never let a rejection break the interaction flow.
export async function recordAoiActivityEvent(
  sessionPath: string,
  input: AoiActivityEventRecordInput,
): Promise<AoiActivityEventRecordResponse> {
  const response = await fetch(`${API_PREFIX}/activity/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      kind: input.kind,
      appId: input.appId,
      actionType: input.actionType,
      observedAt: input.observedAt,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi activity event.');
  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
  };
}

export async function fetchAoiAutonomyDashboard(
  sessionPath: string,
): Promise<AoiAutonomyDashboardSnapshot> {
  const [
    status,
    proposals,
    goals,
    mission,
    environmentSources,
    workspace,
    contextRouter,
    evaluation,
    timeline,
    flightRecorder,
    scheduler,
    health,
    playbooks,
    opportunities,
    deliberations,
    proactiveBriefs,
    fieldFeedback,
    outcomeLearning,
  ] = await Promise.all([
    fetchAoiAutonomyStatus(sessionPath),
    fetchAoiAutonomyProposals(sessionPath, true),
    fetchAoiAutonomyGoals(sessionPath),
    fetchAoiMissionState(sessionPath),
    fetchAoiEnvironmentSources(sessionPath),
    fetchAoiWorkspaceSnapshot(sessionPath),
    fetchAoiContextRouter(sessionPath),
    fetchAoiAutonomyEvaluation(sessionPath),
    fetchAoiAutonomyTimeline(sessionPath, { limit: 20 }),
    fetchAoiOperatorFlightRecorder(sessionPath, { limit: 20 }),
    fetchAoiAutonomyScheduler(sessionPath),
    fetchAoiOperatorHealth(sessionPath),
    fetchAoiPlaybooks(sessionPath, true),
    fetchAoiOpportunityInbox(sessionPath, true),
    fetchAoiDeliberationRuns(sessionPath, 20),
    fetchAoiProactiveBriefs(sessionPath),
    fetchAoiFieldFeedback(sessionPath),
    fetchAoiOutcomeLearning(sessionPath),
  ]);

  return {
    sessionPath,
    status,
    proposals,
    goals,
    mission: mission.mission,
    environmentSources: environmentSources.registry,
    workspaceSnapshot: workspace.snapshot,
    contextRouter: contextRouter.context,
    evaluation: evaluation.evaluation,
    timeline: timeline.summary,
    flightRecorder,
    scheduler: scheduler.state,
    health: health.health,
    playbooks,
    opportunities,
    deliberations,
    proactiveBriefs,
    fieldFeedback,
    outcomeLearning,
  };
}

export async function updateAoiAutonomyPolicy(
  sessionPath: string,
  policy: Partial<AoiAutonomyPolicy>,
): Promise<AoiAutonomyPolicyUpdateResult> {
  const response = await fetch(`${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath, policy }),
  });
  const payload = await readJsonRecord(response, 'Failed to update Aoi autonomy policy.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    policy: requireRecordField<AoiAutonomyPolicy>(
      payload,
      'policy',
      'Aoi autonomy policy response was malformed.',
    ),
  };
}

export async function updateAoiEnvironmentSource(
  sessionPath: string,
  input: AoiEnvironmentSourceUpdateInput,
): Promise<AoiEnvironmentSourceUpdateResult> {
  const response = await fetch(`${API_PREFIX}/sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      sourceId: input.sourceId,
      patch: serializeAoiEnvironmentSourcePatch(input.patch),
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to update Aoi environment source.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    registry: requireRecordField<AoiEnvironmentSourceRegistry>(
      payload,
      'registry',
      'Aoi environment source response was malformed.',
    ),
    status: isRecord(payload.status) ? (payload.status as unknown as AoiAutonomyStatus) : undefined,
  };
}

export async function runAoiAutonomyManualTick(params: {
  sessionPath: string;
  latestUserMessage?: string;
  llmConfig?: unknown;
  reason?: AoiAutonomyTickReason;
  maxRuntimeMs?: number;
  quietMode?: boolean;
  userIdleMs?: number;
  language?: AoiCardLang;
}): Promise<AoiAutonomyTickResult> {
  const response = await fetch(`${API_PREFIX}/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      reason: params.reason ?? 'manual',
      latestUserMessage: params.latestUserMessage,
      llmConfig: params.llmConfig,
      maxRuntimeMs: params.maxRuntimeMs,
      quietMode: params.quietMode,
      userIdleMs: params.userIdleMs,
      language: params.language,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to run Aoi autonomy check.');
  if (payload.ok !== true) {
    throw new Error(getErrorMessage(payload, 'Aoi autonomy check did not complete.'));
  }
  return payload as unknown as AoiAutonomyTickResult;
}

export async function decideAoiProposal(
  sessionPath: string,
  input: AoiAutonomyProposalDecisionInput,
): Promise<AoiAutonomyProposalDecisionResult> {
  const response = await fetch(`${API_PREFIX}/proposal/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      proposalId: input.proposalId,
      action: input.action,
      actor: 'user',
      reason: input.reason,
      feedbackCategory: input.feedbackCategory,
      feedbackNote: input.feedbackNote,
      snoozeMs: input.snoozeMs,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi proposal decision.');

  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    proposal: requireRecordField<AoiProposal>(
      payload,
      'proposal',
      'Aoi proposal decision response was malformed.',
    ),
    decision: requireRecordField<AoiProposalDecision>(
      payload,
      'decision',
      'Aoi proposal decision response was malformed.',
    ),
    goal: isRecord(payload.goal) ? (payload.goal as unknown as AoiGoal) : null,
    active: asArray<AoiProposal>(payload.active),
    archived: asArray<AoiProposal>(payload.archived),
    executed: false,
  };
}

export async function recordAoiProposalFeedback(
  sessionPath: string,
  input: AoiAutonomyProposalFeedbackInput,
): Promise<AoiAutonomyProposalFeedbackResult> {
  const response = await fetch(`${API_PREFIX}/proposal/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      decisionId: input.decisionId,
      feedbackCategory: input.feedbackCategory,
      feedbackNote: input.feedbackNote,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to record Aoi proposal feedback.');

  return {
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : sessionPath,
    decision: requireRecordField<AoiProposalDecision>(
      payload,
      'decision',
      'Aoi proposal feedback response was malformed.',
    ),
    evaluation: isRecord(payload.evaluation)
      ? (payload.evaluation as unknown as AoiAutonomyEvaluationResult)
      : undefined,
  };
}

export async function decideAoiGoal(
  sessionPath: string,
  input: AoiAutonomyGoalDecisionInput,
): Promise<AoiAutonomyGoalDecisionResult> {
  const response = await fetch(`${API_PREFIX}/goal/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      action: input.action,
      goalId: input.goalId,
      proposalId: input.proposalId,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs,
      userConfirmed: input.userConfirmed,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to update Aoi goal.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    goal: isRecord(payload.goal) ? (payload.goal as unknown as AoiGoal) : null,
    active: asArray<AoiGoal>(payload.active),
    archived: asArray<AoiGoal>(payload.archived),
    proposal: isRecord(payload.proposal) ? (payload.proposal as unknown as AoiProposal) : undefined,
    decision: isRecord(payload.decision)
      ? (payload.decision as unknown as AoiProposalDecision)
      : undefined,
    status: isRecord(payload.status) ? (payload.status as unknown as AoiAutonomyStatus) : undefined,
  };
}

export async function decideAoiMission(
  sessionPath: string,
  input: AoiAutonomyMissionDecisionInput,
): Promise<AoiAutonomyMissionResponse> {
  const response = await fetch(`${API_PREFIX}/mission/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath,
      action: input.action,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to update Aoi mission.');
  const responseSessionPath =
    typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
      ? payload.sessionPath
      : sessionPath;

  return {
    sessionPath: responseSessionPath,
    mission: isRecord(payload.mission) ? (payload.mission as unknown as AoiMissionState) : null,
    status: isRecord(payload.status) ? (payload.status as unknown as AoiAutonomyStatus) : undefined,
  };
}

export async function executeAoiProposalAction(params: {
  sessionPath: string;
  proposalId: string;
  decisionId?: string;
}): Promise<AoiAutonomyProposalExecutionResult> {
  const response = await fetch(`${API_PREFIX}/proposal/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      proposalId: params.proposalId,
      decisionId: params.decisionId,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to execute Aoi proposal.');

  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : params.sessionPath,
    proposal: requireRecordField<AoiProposal>(
      payload,
      'proposal',
      'Aoi proposal execution response was malformed.',
    ),
    decision: requireRecordField<AoiProposalDecision>(
      payload,
      'decision',
      'Aoi proposal execution response was malformed.',
    ),
    status: requireRecordField<AoiAutonomyStatus>(
      payload,
      'status',
      'Aoi proposal execution response was malformed.',
    ),
    executed: payload.executed === true,
    outcome:
      payload.outcome === 'executed' || payload.outcome === 'failed' ? payload.outcome : 'blocked',
    reasons: asArray<string>(payload.reasons),
    result: isRecord(payload.result) ? payload.result : undefined,
  };
}

export async function previewAoiProposalAction(params: {
  sessionPath: string;
  proposalId: string;
}): Promise<AoiAutonomyProposalPreviewResult> {
  const response = await fetch(`${API_PREFIX}/proposal/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionPath: params.sessionPath,
      proposalId: params.proposalId,
    }),
  });
  const payload = await readJsonRecord(response, 'Failed to preview Aoi proposal.');

  return {
    ok: payload.ok === true,
    sessionPath:
      typeof payload.sessionPath === 'string' && payload.sessionPath.trim()
        ? payload.sessionPath
        : params.sessionPath,
    proposal: requireRecordField<AoiProposal>(
      payload,
      'proposal',
      'Aoi proposal preview response was malformed.',
    ),
    status: requireRecordField<AoiAutonomyStatus>(
      payload,
      'status',
      'Aoi proposal preview response was malformed.',
    ),
    previewed: payload.previewed === true,
    outcome: payload.outcome === 'previewed' ? 'previewed' : 'blocked',
    reasons: asArray<string>(payload.reasons),
    result: isRecord(payload.result) ? payload.result : undefined,
  };
}
