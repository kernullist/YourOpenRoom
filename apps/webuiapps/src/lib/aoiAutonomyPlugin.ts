import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'crypto';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { executeAoiProposal, previewAoiProposal } from './aoiAutonomyExecution';
import { runAoiAutonomyBackgroundTick } from './aoiAutonomyEngine';
import { normalizeAoiCardLang } from './aoiAutonomyCardI18n';
import {
  resolveAoiAutonomyBackgroundConfigFromEnv,
  startAoiAutonomyBackgroundRunner,
  type AoiAutonomyBackgroundCycleResult,
  type AoiAutonomyBackgroundRunnerHandle,
} from './aoiAutonomyBackgroundRunner';
import { acquireAoiAutonomyLoopLock } from './aoiAutonomyLoopLock';
import {
  archiveServerAoiMemories,
  computeServerAoiMemoryDecayDryRun,
  saveServerAoiMemoryEpisode,
  unarchiveServerAoiMemories,
  updateServerAoiMemoryFromExplicitCorrection,
} from './aoiMemoryServerWriter';
import { loadAoiMemoryEmbeddingStatus } from './aoiMemoryEmbeddingStatus';
import { loadAoiUnifiedOperatorSummaryFromStores } from './aoiUnifiedOperatorModelServer';
import { loadAoiProactiveTrendReadinessFromStores } from './aoiProactiveTrendReadinessServer';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import { recordAoiOutcomeFeedbackFromUserMessage } from './aoiOutcomeFeedbackServer';
import {
  resolveAoiMemoryEmbedSweepConfigFromEnv,
  startAoiMemoryEmbedSweep,
  type AoiMemoryEmbedSweepHandle,
} from './aoiMemoryEmbedSweep';
import { resolveAoiMemoryConsolidationConfigFromEnv } from './aoiMemoryConsolidationSweep';
import { loadAoiMainLlmConfig } from './dewdropCanvasPlugin';
import { buildAoiAutonomyEvaluation } from './aoiAutonomyEvaluation';
import { loadAoiDeliberationRuns } from './aoiDeliberationRun';
import { resetAoiTrustCalibrationCategory } from './aoiTrustCalibrationStore';
import {
  activateAoiGoalFromProposal,
  applyAoiGoalDecision,
  loadAoiActiveGoals,
  loadAoiArchivedGoals,
  loadAoiGoalProgressEvents,
  updateAoiGoalProgressFromObservations,
} from './aoiAutonomyGoals';
import {
  applyAoiProposalFeedback,
  applyAoiProposalDecision,
  buildAoiAutonomyStatus,
  appendAoiOutcomeSignalRecord,
  loadAoiEnvironmentSourceRegistry,
  loadAoiActiveProposals,
  loadAoiAppOperationDispatches,
  loadAoiArchivedProposals,
  loadAoiActiveOpportunities,
  loadAoiArchivedOpportunities,
  loadAoiFollowThroughLearningSummary,
  loadAoiObservations,
  loadAoiAutonomyPolicy,
  loadAoiFieldShadowRecordReport,
  loadAoiOperatorFeedbackLabelActions,
  loadAoiOutcomeLearningSummary,
  loadAoiOutcomeSignalRecords,
  loadAoiProposalDecisions,
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
  saveAoiAutonomyPolicy,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import { loadAoiStrategicBrief } from './aoiStrategicBrief';
import { getAoiApprovedAppActionPolicyForProposal } from './aoiAutonomyPolicy';
import { selectAoiServerValidatedAppDispatches } from './aoiServerAppDispatchValidation';
import { deriveAoiApprovedAppActionDispatchTarget } from './aoiApprovedAppActionPolicy';
import { recordAoiAppOperationDispatchResult } from './aoiAppOperationDispatchServer';
import { recordAoiFieldFeedbackLearningAction } from './aoiFieldFeedbackLearning';
import { buildAoiOperatorFeedbackInbox } from './aoiOperatorFeedbackInbox';
import {
  createAoiOperatorFlightReplayDraft,
  loadAoiOperatorFlightRecords,
  loadAoiOperatorFlightRecorderSummary,
  loadAoiOperatorFlightReplayDrafts,
  recordAoiOperatorFlightRecord,
} from './aoiOperatorFlightRecorder';
import { applyAoiMissionDecision, deriveAoiMissionState } from './aoiAutonomyMission';
import {
  collectAndPersistAoiWorkspaceSnapshot,
  loadAoiWorkspaceSnapshot,
  recordAoiValidationSignal,
} from './aoiWorkspaceSignals';
import { recordAoiPlaybookRelations } from './aoiAutonomyRelations';
import {
  buildAoiContextRouterResult,
  recordAoiBrowserContextMetadata,
  recordAoiContextSourceFeedback,
} from './aoiContextRouter';
import { loadAoiActivityStreamSummary, recordAoiActivityEvent } from './aoiActivityStream';
import { loadAoiIntentState } from './aoiIntentInference';
import { loadAoiCurrentSituation } from './aoiCurrentSituationModel';
import { buildAoiServerCognitionReadinessScorecard } from './aoiCognitionReadinessServer';
import { loadAoiNonVoiceJarvisScorecardFromStores } from './aoiNonVoiceJarvisScorecardServer';
import type { AoiDaemonHealthSnapshot } from './aoiDaemonHealth';
import { resolveAoiWorkspaceCodeFingerprint } from './aoiWorkspaceCodeFingerprint';
import { embedAoiQuery } from './aoiMemoryEmbedding';
import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import {
  applyAoiOperatorPromotionReview,
  loadAoiOperatorReviewQueue,
} from './aoiOperatorPromotionReviewServer';
import {
  buildAoiContextRouterTimelineEvents,
  exportAoiOperatorTrace,
  loadAoiOperatorTimelineEvents,
  loadAoiOperatorTimelineSummary,
  recordAoiOperatorVoiceDecisionTimelineEvent,
  recordAoiOutcomeSignalTimelineEvent,
  recordAoiOperatorTimelineEvent,
  recordAoiProposalDecisionTimelineEvent,
  recordAoiProposalFeedbackTimelineEvent,
} from './aoiOperatorTimeline';
import {
  isAoiAutonomyWakeupReason,
  loadAoiAutonomySchedulerState,
  runAoiAutonomyWakeup,
} from './aoiAutonomyScheduler';
import { applyAoiProactiveBriefFeedbackAction } from './aoiProactiveBriefFeedback';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCalibrationInbox,
  loadAoiProactiveBriefCalibrationTuning,
  loadAoiProactiveBriefCandidates,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFieldMetrics,
  loadAoiProactiveBriefFeedback,
  recordAoiProactiveBriefFieldEvent,
  recordAoiProactiveBriefDeliveryFieldEvents,
  upsertAoiProactiveBriefCooldown,
} from './aoiProactiveBriefStore';
import { AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY } from './aoiProactiveBriefPlanner';
import { decideAoiProactiveBriefDelivery } from './aoiProactiveBriefPolicy';
import { buildAoiProactiveBriefPanelModel } from './aoiProactiveBriefUi';
import type { AoiShadowDecisionLabel } from './aoiShadowModeEvaluation';
import {
  buildAoiProactiveTrendAdvisorState,
  isAoiProactiveTrendDeliveryEventKind,
  loadAoiProactiveTrendSnapshots,
  recordAoiProactiveTrendDeliveryEventFromSnapshot,
} from './aoiProactiveTrendAdvisor';
import {
  checkAoiDirectChatBudget,
  DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
  loadAoiDirectChatBudgetState,
  recordAoiDirectChatOffer,
  saveAoiDirectChatBudgetState,
} from './aoiDirectChatBudget';
import {
  buildAoiOperatorHealthReplayScenarios,
  buildAoiOperatorHealthState,
} from './aoiOperatorHealthServer';
import {
  findAoiPlaybook,
  loadAoiActivePlaybooks,
  loadAoiArchivedPlaybooks,
  prepareAoiPlaybook,
  updateAoiPlaybookFromEvidence,
  upsertAoiPlaybook,
} from './aoiPlaybookOrchestrator';
import type {
  AoiCalibrationDimension,
  AoiAutonomyTickReason,
  AoiAutonomyWakeupBudget,
  AoiFollowThroughDeliveryMode,
  AoiGoal,
  AoiLearningSignalKind,
  AoiOperatorTimelineEventKind,
  AoiOutcomePrivacyState,
  AoiOutcomeSignalKind,
  AoiPlaybookEvidenceKind,
  AoiPlaybookStepRefs,
  AoiProposal,
  AoiProposalFeedbackCategory,
  AoiProactiveBriefFeedbackCategory,
  AoiVoiceRenderDecision,
} from './aoiAutonomyTypes';
import type { LLMConfig } from './llmModels';

const API_PREFIX = '/api/aoi-autonomy';
const MAX_BODY_BYTES = 128 * 1024;

export interface AoiAutonomyPluginOptions {
  sessionsDir: string;
  configFile: string;
  workspaceRoot?: string;
  getDaemonHealthSnapshot?: (now: number) => AoiDaemonHealthSnapshot | null;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString() || '{}';
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Request body must be a JSON object.'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function getAoiAutonomyRoute(pathname: string): string | null {
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }
  return pathname.slice(API_PREFIX.length) || '/';
}

function getSessionPathFromUrl(url: URL): string | null {
  return normalizeAoiAutonomySessionPath(url.searchParams.get('sessionPath'));
}

function isAoiAutonomyTickReason(value: unknown): value is AoiAutonomyTickReason {
  return (
    value === 'manual' ||
    value === 'turn' ||
    value === 'periodic' ||
    value === 'research_run' ||
    value === 'kira' ||
    value === 'proposal' ||
    value === 'memory' ||
    value === 'app'
  );
}

function isAoiOperatorTimelineEventKind(value: unknown): value is AoiOperatorTimelineEventKind {
  return (
    value === 'observation_ingested' ||
    value === 'source_selected' ||
    value === 'source_suppressed' ||
    value === 'proposal_created' ||
    value === 'proposal_blocked' ||
    value === 'proposal_accepted' ||
    value === 'proposal_dismissed' ||
    value === 'proposal_snoozed' ||
    value === 'proposal_executed' ||
    value === 'proposal_failed' ||
    value === 'mission_state_changed' ||
    value === 'goal_state_changed' ||
    value === 'digest_item_surfaced' ||
    value === 'digest_item_hidden' ||
    value === 'approved_command_previewed' ||
    value === 'approved_command_recorded' ||
    value === 'feedback_recorded' ||
    value === 'operator_voice_decision' ||
    value === 'wakeup_recorded' ||
    value === 'outcome_signal_recorded' ||
    value === 'trace_exported'
  );
}

function isAoiCalibrationDimension(value: unknown): value is AoiCalibrationDimension {
  return (
    value === 'source_kind' ||
    value === 'trigger_kind' ||
    value === 'action_kind' ||
    value === 'risk_level' ||
    value === 'notification_lane' ||
    value === 'voice_category' ||
    value === 'interruption_gap' ||
    value === 'feedback_category'
  );
}

function isAoiPlaybookEvidenceKind(value: unknown): value is AoiPlaybookEvidenceKind {
  return (
    value === 'inspect_context_completed' ||
    value === 'read_research_artifact_completed' ||
    value === 'research_completed' ||
    value === 'kira_work_created' ||
    value === 'kira_work_completed' ||
    value === 'approved_command_recorded' ||
    value === 'summarize_result_completed' ||
    value === 'user_decision_recorded' ||
    value === 'step_failed'
  );
}

function isAoiProactiveBriefFeedbackCategory(
  value: unknown,
): value is AoiProactiveBriefFeedbackCategory {
  return (
    value === 'useful' ||
    value === 'not_useful' ||
    value === 'show_more' ||
    value === 'show_less' ||
    value === 'wrong_topic' ||
    value === 'wrong_timing' ||
    value === 'too_frequent' ||
    value === 'stale' ||
    value === 'unsafe' ||
    value === 'mute_topic' ||
    value === 'pin_topic' ||
    value === 'archive_brief' ||
    value === 'open_sources' ||
    value === 'expand_summary'
  );
}

function isAoiShadowDecisionLabel(value: unknown): value is AoiShadowDecisionLabel {
  return (
    value === 'useful' ||
    value === 'too_much' ||
    value === 'too_frequent' ||
    value === 'wrong_source' ||
    value === 'wrong_timing' ||
    value === 'unsafe' ||
    value === 'missed_context' ||
    value === 'should_have_spoken' ||
    value === 'show_more' ||
    value === 'show_less' ||
    value === 'mute_topic' ||
    value === 'pin_topic'
  );
}

function isAoiOutcomeSignalKind(value: unknown): value is AoiOutcomeSignalKind {
  return (
    value === 'proposal_opened' ||
    value === 'proposal_ignored' ||
    value === 'direct_chat_dismissed' ||
    value === 'work_order_approved' ||
    value === 'work_order_rejected' ||
    value === 'user_feedback' ||
    value === 'validation_run' ||
    value === 'commit_created' ||
    value === 'user_correction'
  );
}

function isAoiLearningSignalKind(value: unknown): value is AoiLearningSignalKind {
  return (
    value === 'explicit_label' || value === 'explicit_correction' || value === 'passive_outcome'
  );
}

function isAoiOutcomePrivacyState(value: unknown): value is AoiOutcomePrivacyState {
  return (
    value === 'metadata_only' ||
    value === 'redacted' ||
    value === 'synthetic' ||
    value === 'unknown'
  );
}

function isAoiFollowThroughDeliveryMode(value: unknown): value is AoiFollowThroughDeliveryMode {
  return (
    value === 'dashboard' ||
    value === 'inline_card' ||
    value === 'quiet_notification' ||
    value === 'direct_chat' ||
    value === 'digest' ||
    value === 'chat_hook' ||
    value === 'hidden' ||
    value === 'blocked' ||
    value === 'unknown'
  );
}

function getOptionalBodyString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : undefined;
}

function getOptionalBodyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function buildAoiProactiveBriefResponse(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const policy = loadAoiAutonomyPolicy(params.sessionsDir, params.sessionPath);
  const profile = loadAoiInterestProfile(params.sessionsDir, params.sessionPath, now);
  const candidates = loadAoiProactiveBriefCandidates(params.sessionsDir, params.sessionPath, now);
  const feedback = loadAoiProactiveBriefFeedback(params.sessionsDir, params.sessionPath);
  const cooldownState = loadAoiProactiveBriefCooldownState(
    params.sessionsDir,
    params.sessionPath,
    now,
  );
  const calibrationTuning = loadAoiProactiveBriefCalibrationTuning(
    params.sessionsDir,
    params.sessionPath,
    now,
  );
  const deliveryContext = {
    now,
    quietMode: true,
    directChatOptIn: false,
    maxInlineCards: 0,
    inlineCardsShown: 0,
  };
  const deliveryDecisions = candidates.map((candidate) =>
    decideAoiProactiveBriefDelivery({
      candidate,
      policy,
      profile,
      feedback,
      cooldownState,
      calibrationTuning,
      context: deliveryContext,
    }),
  );
  try {
    recordAoiProactiveBriefDeliveryFieldEvents({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      candidates,
      decisions: deliveryDecisions,
      now,
    });
  } catch (error) {
    console.warn('[AoiAutonomyPlugin] Failed to record proactive brief field events', error);
  }
  const fieldMetrics = loadAoiProactiveBriefFieldMetrics(
    params.sessionsDir,
    params.sessionPath,
    now,
  );
  const calibrationInbox = loadAoiProactiveBriefCalibrationInbox(
    params.sessionsDir,
    params.sessionPath,
    now,
  );
  const panel = buildAoiProactiveBriefPanelModel({
    candidates,
    policy,
    profile,
    feedback,
    cooldownState,
    calibrationInbox,
    calibrationTuning,
    context: deliveryContext,
  });
  const trendAdvisor = buildAoiProactiveTrendAdvisorState({
    sessionsDir: params.sessionsDir,
    sessionPath: params.sessionPath,
    policy,
    profile,
    candidates,
    feedback,
    fieldMetrics,
    calibrationTuning,
    now,
  });
  return {
    ok: true,
    sessionPath: params.sessionPath,
    candidates,
    feedback,
    profile,
    cooldownState,
    fieldMetrics,
    calibrationInbox,
    calibrationTuning,
    panel,
    trendAdvisor,
  };
}

function buildAoiFieldFeedbackResponse(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const fieldShadowReport = loadAoiFieldShadowRecordReport(
    params.sessionsDir,
    params.sessionPath,
    now,
  );
  const labelActions = loadAoiOperatorFeedbackLabelActions(params.sessionsDir, params.sessionPath);
  const feedbackInbox = buildAoiOperatorFeedbackInbox({
    sessionPath: params.sessionPath,
    fieldShadowReport,
    labelActions,
    now,
  });
  return {
    ok: true,
    sessionPath: params.sessionPath,
    fieldShadowReport,
    labelActions,
    feedbackInbox,
  };
}

function buildAoiOutcomeLearningResponse(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
  fieldReadinessEvidence?: boolean;
}) {
  const now = params.now ?? Date.now();
  return {
    ok: true,
    sessionPath: params.sessionPath,
    outcomes: loadAoiOutcomeSignalRecords(params.sessionsDir, params.sessionPath, now),
    summary: loadAoiOutcomeLearningSummary(
      params.sessionsDir,
      params.sessionPath,
      now,
      params.fieldReadinessEvidence === true,
    ),
  };
}

function buildAoiOperatorFlightRecorderResponse(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
  limit?: number;
}) {
  const now = params.now ?? Date.now();
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(Math.max(Math.trunc(params.limit), 1), 200)
      : 50;
  return {
    ok: true,
    sessionPath: params.sessionPath,
    records: loadAoiOperatorFlightRecords(params.sessionsDir, params.sessionPath, now, limit),
    replayDrafts: loadAoiOperatorFlightReplayDrafts(params.sessionsDir, params.sessionPath, 20),
    summary: loadAoiOperatorFlightRecorderSummary(params.sessionsDir, params.sessionPath, now),
  };
}

function getWakeupBudgetFromBody(value: unknown): Partial<AoiAutonomyWakeupBudget> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Partial<AoiAutonomyWakeupBudget>;
}

function getHeaderString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function getRequestOrigin(req: IncomingMessage): string {
  const forwardedProto = getHeaderString(req.headers['x-forwarded-proto']).trim();
  const host = getHeaderString(req.headers.host).trim() || '127.0.0.1:3000';
  return `${forwardedProto || 'http'}://${host}`;
}

function recordAoiTimelineBestEffort(record: () => void): void {
  try {
    record();
  } catch (error) {
    console.warn('[AoiAutonomyPlugin] Failed to record Aoi timeline event', error);
  }
}

function recordAoiPlaybookRelationsBestEffort(params: {
  sessionsDir: string;
  sessionPath: string;
  playbook: Parameters<typeof recordAoiPlaybookRelations>[0]['playbook'];
}): void {
  try {
    recordAoiPlaybookRelations(params);
  } catch (error) {
    console.warn('[AoiAutonomyPlugin] Failed to record Aoi playbook relations', error);
  }
}

function idFromRef(ref: string | undefined, prefix: string): string | undefined {
  if (!ref?.startsWith(prefix)) {
    return undefined;
  }
  return ref.slice(prefix.length);
}

function findProposalForPlaybook(
  sessionsDir: string,
  sessionPath: string,
  proposalId: unknown,
): AoiProposal | null {
  const id = typeof proposalId === 'string' ? proposalId.trim() : '';
  if (!id) {
    return null;
  }
  return (
    [
      ...loadAoiActiveProposals(sessionsDir, sessionPath),
      ...loadAoiArchivedProposals(sessionsDir, sessionPath),
    ].find((proposal) => proposal.id === id) ?? null
  );
}

function findGoalForPlaybook(
  sessionsDir: string,
  sessionPath: string,
  goalId: unknown,
): AoiGoal | null {
  const id = typeof goalId === 'string' ? goalId.trim() : '';
  if (!id) {
    return null;
  }
  return (
    [
      ...loadAoiActiveGoals(sessionsDir, sessionPath),
      ...loadAoiArchivedGoals(sessionsDir, sessionPath),
    ].find((goal) => goal.id === id) ?? null
  );
}

export async function handleAoiAutonomyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
  configFile: string,
  workspaceRoot: string,
  getDaemonHealthSnapshot?: (now: number) => AoiDaemonHealthSnapshot | null,
): Promise<boolean> {
  const route = getAoiAutonomyRoute(url.pathname);
  if (route === null) {
    return false;
  }

  try {
    if (req.method === 'GET' && route === '/status') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/strategic-brief') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // Read-only: the last continuity brief persisted by a tick (P1a). Already
      // redacted at load; lets the operator UI show it on open without a tick.
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        brief: loadAoiStrategicBrief(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/app-operation-dispatch') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // P2/B3-1: the connected client bridge polls 'pending' app-operation dispatches
      // and runs each over the agent->app bus (the server loop cannot postMessage to an
      // app iframe). Read-only: returns the queued records; dispatch is the client's job.
      //
      // P2.2: re-check the content-addressed approval fingerprint SERVER-SIDE before
      // advertising, so the daemon never hands the bridge a dispatch whose approval
      // changed/vanished since queueing. The client bridge still re-checks before it
      // publishes -- this is defense in depth, not a replacement.
      const proposalsById = new Map(
        loadAoiActiveProposals(sessionsDir, sessionPath).map((proposal) => [proposal.id, proposal]),
      );
      const dispatchSelection = selectAoiServerValidatedAppDispatches({
        records: loadAoiAppOperationDispatches(sessionsDir, sessionPath),
        lookupProposal: (proposalId) => proposalsById.get(proposalId) ?? null,
        recomputeApprovalFingerprint: (proposal) => {
          const now = Date.now();
          const policy = getAoiApprovedAppActionPolicyForProposal(proposal, now);
          return {
            fingerprint: policy.approvalFingerprint,
            expiresAt: policy.expiresAt,
          };
        },
        deriveApprovedAction: (proposal) =>
          deriveAoiApprovedAppActionDispatchTarget(proposal.acceptAction?.params),
        now: Date.now(),
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        pending: dispatchSelection.eligible,
        rejected: dispatchSelection.rejected,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/app-operation-dispatch') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const id = getOptionalBodyString(body.id);
      if (!id) {
        writeJson(res, 400, {
          error: 'A dispatch id is required.',
          code: 'invalid_dispatch_id',
        });
        return true;
      }
      const status = body.status === 'dispatched' || body.status === 'failed' ? body.status : null;
      if (!status) {
        writeJson(res, 400, {
          error: 'status must be "dispatched" or "failed".',
          code: 'invalid_dispatch_status',
        });
        return true;
      }
      // The client bridge reports the agent->app dispatch result. The recorder updates
      // the record in place (pending -> dispatched|failed), writes a run-ledger event,
      // and ingests an observation; it is idempotent on an already-resolved record.
      const outcome = recordAoiAppOperationDispatchResult({
        sessionsDir,
        sessionPath,
        id,
        status,
        actionResult: getOptionalBodyString(body.actionResult),
        failureReason: getOptionalBodyString(body.failureReason),
        now: typeof body.now === 'number' ? body.now : Date.now(),
      });
      if (!outcome.found) {
        writeJson(res, 404, {
          error: 'No app-operation dispatch matches that id.',
          code: 'dispatch_not_found',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        dispatch: outcome.dispatch,
        alreadyResolved: outcome.alreadyResolved,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/proposals') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActiveProposals(sessionsDir, sessionPath),
        archived: includeArchived ? loadAoiArchivedProposals(sessionsDir, sessionPath) : [],
      });
      return true;
    }

    if (req.method === 'GET' && route === '/opportunities') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActiveOpportunities(sessionsDir, sessionPath),
        archived: includeArchived ? loadAoiArchivedOpportunities(sessionsDir, sessionPath) : [],
      });
      return true;
    }

    if (req.method === 'GET' && route === '/deliberations') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
      const runs = loadAoiDeliberationRuns(sessionsDir, sessionPath).slice(
        0,
        Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 80) : 20,
      );
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        latest: runs[0] ?? null,
        runs,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/decisions') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        decisions: loadAoiProposalDecisions(sessionsDir, sessionPath).slice(
          0,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
        ),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/reflections') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        reflections: loadAoiReflections(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/observations') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        observations: loadAoiObservations(sessionsDir, sessionPath).slice(
          0,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
        ),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/timeline') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        events: loadAoiOperatorTimelineEvents(sessionsDir, sessionPath, {
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
        }),
        summary: loadAoiOperatorTimelineSummary(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/flight-recorder') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(
        res,
        200,
        buildAoiOperatorFlightRecorderResponse({
          sessionsDir,
          sessionPath,
          limit,
        }),
      );
      return true;
    }

    if (req.method === 'GET' && route === '/scheduler') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        state: loadAoiAutonomySchedulerState(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/health') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        health: buildAoiOperatorHealthState({
          sessionsDir,
          sessionPath,
          configFile,
          // P5.3: feed the built-in operator replay fixtures so replay-backed health
          // blockers actually fire (the model was previously dark).
          replayScenarios: buildAoiOperatorHealthReplayScenarios(),
        }),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/playbooks') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActivePlaybooks(sessionsDir, sessionPath),
        archived: includeArchived ? loadAoiArchivedPlaybooks(sessionsDir, sessionPath) : [],
      });
      return true;
    }

    if (req.method === 'POST' && route === '/playbooks/prepare') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const mission = deriveAoiMissionState({ sessionsDir, sessionPath });
      const proposal =
        findProposalForPlaybook(sessionsDir, sessionPath, body.proposalId) ??
        findProposalForPlaybook(
          sessionsDir,
          sessionPath,
          idFromRef(mission.sourceRefs.proposalRef, 'proposal:'),
        );
      const goal =
        findGoalForPlaybook(sessionsDir, sessionPath, body.goalId) ??
        findGoalForPlaybook(sessionsDir, sessionPath, mission.activeGoalId);
      const health = buildAoiOperatorHealthState({
        sessionsDir,
        sessionPath,
        configFile,
      });
      const playbook = upsertAoiPlaybook(
        sessionsDir,
        sessionPath,
        prepareAoiPlaybook({
          sessionPath,
          proposal,
          activeGoal: goal,
          mission,
          health,
          title: typeof body.title === 'string' ? body.title : undefined,
          objective: typeof body.objective === 'string' ? body.objective : undefined,
        }),
      );
      recordAoiPlaybookRelationsBestEffort({
        sessionsDir,
        sessionPath,
        playbook,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        playbook,
        active: loadAoiActivePlaybooks(sessionsDir, sessionPath),
        archived: loadAoiArchivedPlaybooks(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/playbooks/update') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const playbookId = typeof body.playbookId === 'string' ? body.playbookId.trim() : '';
      const playbook = findAoiPlaybook(sessionsDir, sessionPath, playbookId);
      if (!playbook) {
        writeJson(res, 404, {
          error: 'Aoi playbook was not found.',
          code: 'playbook_not_found',
        });
        return true;
      }
      if (!isAoiPlaybookEvidenceKind(body.kind)) {
        writeJson(res, 400, {
          error: 'Invalid playbook evidence kind.',
          code: 'invalid_playbook_evidence_kind',
        });
        return true;
      }
      const updated = upsertAoiPlaybook(
        sessionsDir,
        sessionPath,
        updateAoiPlaybookFromEvidence({
          playbook,
          kind: body.kind,
          stepId: typeof body.stepId === 'string' ? body.stepId : undefined,
          resultSummary: typeof body.resultSummary === 'string' ? body.resultSummary : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
          refs:
            body.refs && typeof body.refs === 'object' && !Array.isArray(body.refs)
              ? (body.refs as Partial<AoiPlaybookStepRefs>)
              : undefined,
          failedReason: typeof body.failedReason === 'string' ? body.failedReason : undefined,
        }),
      );
      recordAoiPlaybookRelationsBestEffort({
        sessionsDir,
        sessionPath,
        playbook: updated,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        playbook: updated,
        active: loadAoiActivePlaybooks(sessionsDir, sessionPath),
        archived: loadAoiArchivedPlaybooks(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/goals') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActiveGoals(sessionsDir, sessionPath),
        archived: loadAoiArchivedGoals(sessionsDir, sessionPath),
        progress: loadAoiGoalProgressEvents(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/evaluation') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
      });
      return true;
    }

    // Operator-review -> persisted-promotion pipeline (roadmap item 1). The review
    // queue lists the trace / adaptive replay candidates and the operator's progress
    // toward the promoted-replay gate that unlocks trusted_operator.
    if (req.method === 'GET' && route === '/review-candidates') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        queue: loadAoiOperatorReviewQueue(sessionsDir, sessionPath),
      });
      return true;
    }

    // Record one operator review decision. SAFETY: the actor is FORCED to 'user' by
    // the pipeline and the actor-gated store -- the request body can never set it, so
    // this human-operator route is the ONLY way a promotion is ever created.
    if (req.method === 'POST' && route === '/review-decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const kind = body.kind;
      if (kind !== 'trace' && kind !== 'adaptive') {
        writeJson(res, 400, { error: 'kind must be trace or adaptive.', code: 'invalid_kind' });
        return true;
      }
      const action = body.action;
      if (action !== 'promote' && action !== 'defer' && action !== 'reject') {
        writeJson(res, 400, {
          error: 'action must be promote, defer, or reject.',
          code: 'invalid_action',
        });
        return true;
      }
      const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
      if (!candidateId) {
        writeJson(res, 400, { error: 'candidateId is required.', code: 'invalid_candidate_id' });
        return true;
      }
      try {
        const { result, queue } = applyAoiOperatorPromotionReview(sessionsDir, sessionPath, {
          kind,
          candidateId,
          action,
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
        if (!result.ok) {
          writeJson(res, result.code === 'candidate_not_found' ? 404 : 400, {
            error: result.error,
            code: result.code,
            sessionPath,
            queue,
          });
          return true;
        }
        writeJson(res, 200, { ok: true, sessionPath, result, queue });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(res, 400, { error: message, code: 'review_failed' });
      }
      return true;
    }

    if (req.method === 'GET' && route === '/field-feedback') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(
        res,
        200,
        buildAoiFieldFeedbackResponse({
          sessionsDir,
          sessionPath,
        }),
      );
      return true;
    }

    if (req.method === 'POST' && route === '/field-feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const decisionRecordId =
        typeof body.decisionRecordId === 'string' ? body.decisionRecordId.trim() : '';
      const decisionId = typeof body.decisionId === 'string' ? body.decisionId.trim() : '';
      if (!decisionRecordId || !decisionId || !isAoiShadowDecisionLabel(body.label)) {
        writeJson(res, 400, {
          error: 'decisionRecordId, decisionId, and a supported label are required.',
          code: 'invalid_field_feedback',
        });
        return true;
      }
      try {
        const result = recordAoiFieldFeedbackLearningAction(sessionsDir, {
          sessionPath,
          decisionRecordId,
          decisionId,
          fieldEventId: typeof body.fieldEventId === 'string' ? body.fieldEventId : undefined,
          opportunityId: typeof body.opportunityId === 'string' ? body.opportunityId : undefined,
          topicKey: typeof body.topicKey === 'string' ? body.topicKey : undefined,
          sourceKey: typeof body.sourceKey === 'string' ? body.sourceKey : undefined,
          deliveryMode: typeof body.deliveryMode === 'string' ? body.deliveryMode : undefined,
          label: body.label,
          sourceKinds: Array.isArray(body.sourceKinds)
            ? body.sourceKinds.filter((item): item is string => typeof item === 'string')
            : undefined,
          note: typeof body.note === 'string' ? body.note : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
          now: typeof body.now === 'number' ? body.now : undefined,
        });
        recordAoiTimelineBestEffort(() => {
          recordAoiOperatorTimelineEvent(sessionsDir, {
            sessionPath,
            kind: 'feedback_recorded',
            visibility: 'operator_visible',
            createdAt: result.labelAction.createdAt,
            title: 'Field feedback recorded',
            summary: `Operator labeled field decision as ${result.labelAction.label}.`,
            sourceRef: `field-shadow-record:${result.labelAction.decisionRecordId}`,
            sourceKind: 'field_feedback',
            evidenceRefs: result.summary.evidenceRefs,
            relatedRefs: [
              `operator-feedback:${result.labelAction.id}`,
              `field-shadow-record:${result.labelAction.decisionRecordId}`,
              `field-shadow-decision:${result.labelAction.decisionId}`,
              ...result.appendedFieldEvents.map((event) => `field-event:${event.id}`),
            ],
            metadata: {
              label: result.labelAction.label,
              actionAuthority: result.labelAction.actionAuthority,
              mutationCount: result.labelAction.mutationCount,
              executionPermissionRaised: result.executionPermissionRaised,
            },
          });
        });
        writeJson(res, 200, {
          ...buildAoiFieldFeedbackResponse({
            sessionsDir,
            sessionPath,
            now: result.generatedAt,
          }),
          labelAction: result.labelAction,
          followThroughEvents: result.appendedFollowThroughEvents,
          fieldEvents: result.appendedFieldEvents,
          learningSummary: result.summary,
          followThroughLearning: result.followThroughLearning,
          evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_field_feedback',
        });
      }
      return true;
    }

    if (req.method === 'GET' && route === '/outcomes') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(
        res,
        200,
        buildAoiOutcomeLearningResponse({
          sessionsDir,
          sessionPath,
          fieldReadinessEvidence: url.searchParams.get('fieldReadinessEvidence') === 'true',
        }),
      );
      return true;
    }

    if (req.method === 'POST' && route === '/outcomes/operator-feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      const userMessage = getOptionalBodyString(body.userMessage);
      const sourceChatRef = getOptionalBodyString(body.sourceChatRef);
      if (!sessionPath || !userMessage || !sourceChatRef) {
        writeJson(res, 400, {
          error: 'A sessionPath, latest userMessage, and sourceChatRef are required.',
          code: 'invalid_outcome_feedback',
        });
        return true;
      }
      try {
        const result = recordAoiOutcomeFeedbackFromUserMessage({
          sessionsDir,
          sessionPath,
          userMessage,
          sourceChatRef,
          now: typeof body.now === 'number' ? body.now : undefined,
        });
        result.createdOutcomes.forEach((outcome) => {
          recordAoiTimelineBestEffort(() => {
            recordAoiOutcomeSignalTimelineEvent({ sessionsDir, outcome });
          });
        });
        writeJson(res, 200, {
          ok: true,
          record: result.record,
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_outcome_feedback',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/outcomes') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiOutcomeSignalKind(body.outcomeKind)) {
        writeJson(res, 400, {
          error: 'A supported outcomeKind is required.',
          code: 'invalid_outcome_signal',
        });
        return true;
      }
      try {
        const now = typeof body.now === 'number' ? body.now : Date.now();
        const outcome = appendAoiOutcomeSignalRecord(
          sessionsDir,
          {
            sessionPath,
            id: getOptionalBodyString(body.id),
            eventId: getOptionalBodyString(body.eventId),
            sourceOutcomeId: getOptionalBodyString(body.sourceOutcomeId),
            sourceProposalId: getOptionalBodyString(body.sourceProposalId),
            sourceDecisionId: getOptionalBodyString(body.sourceDecisionId),
            sourceWorkOrderId: getOptionalBodyString(body.sourceWorkOrderId),
            sourceValidationRef: getOptionalBodyString(body.sourceValidationRef),
            sourceCommitRef: getOptionalBodyString(body.sourceCommitRef),
            sourceChatRef: getOptionalBodyString(body.sourceChatRef),
            outcomeKind: body.outcomeKind,
            signalKind: isAoiLearningSignalKind(body.signalKind) ? body.signalKind : undefined,
            confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
            explicitLabelRef: getOptionalBodyString(body.explicitLabelRef),
            explicitLabel: getOptionalBodyString(body.explicitLabel),
            explicitCorrection: getOptionalBodyString(body.explicitCorrection),
            topicKey: getOptionalBodyString(body.topicKey),
            sourceKey: getOptionalBodyString(body.sourceKey),
            deliveryMode: isAoiFollowThroughDeliveryMode(body.deliveryMode)
              ? body.deliveryMode
              : undefined,
            validationPassed:
              typeof body.validationPassed === 'boolean' ? body.validationPassed : undefined,
            evidenceRefs: getOptionalBodyStringArray(body.evidenceRefs),
            privacyState: isAoiOutcomePrivacyState(body.privacyState)
              ? body.privacyState
              : undefined,
            createdAt: typeof body.createdAt === 'number' ? body.createdAt : undefined,
          },
          now,
        );
        recordAoiTimelineBestEffort(() => {
          recordAoiOutcomeSignalTimelineEvent({
            sessionsDir,
            outcome,
          });
        });
        writeJson(res, 200, {
          ...buildAoiOutcomeLearningResponse({
            sessionsDir,
            sessionPath,
            now: outcome.createdAt,
            fieldReadinessEvidence: body.fieldReadinessEvidence === true,
          }),
          outcome,
          followThroughLearning: loadAoiFollowThroughLearningSummary(
            sessionsDir,
            sessionPath,
            outcome.createdAt,
          ),
          timeline: loadAoiOperatorTimelineSummary(sessionsDir, sessionPath),
          evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_outcome_signal',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/calibration/reset') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiCalibrationDimension(body.dimension)) {
        writeJson(res, 400, {
          error: 'Invalid calibration dimension.',
          code: 'invalid_calibration_dimension',
        });
        return true;
      }
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) {
        writeJson(res, 400, {
          error: 'Calibration key is required.',
          code: 'invalid_calibration_key',
        });
        return true;
      }
      const reset = resetAoiTrustCalibrationCategory({
        sessionsDir,
        sessionPath,
        dimension: body.dimension,
        key,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        reset,
        evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/mission') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        mission: deriveAoiMissionState({ sessionsDir, sessionPath }),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/sources') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        registry: loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/workspace') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const collect = url.searchParams.get('collect') !== 'false';
      const snapshot = collect
        ? collectAndPersistAoiWorkspaceSnapshot({
            sessionsDir,
            sessionPath,
            workspaceRoot,
          })
        : loadAoiWorkspaceSnapshot(sessionsDir, sessionPath);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        snapshot,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/context') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const latestUserMessage = url.searchParams.get('latestUserMessage') || '';
      // Best-effort semantic recall: embed the query with the server-resolved
      // provider (null when no key is configured -> lexical-only ranking). A
      // failed/absent embedding yields null, so recall degrades gracefully.
      const contextEmbeddingProvider = createServerAoiEmbeddingProvider({ configFile });
      const queryEmbedding = await embedAoiQuery(latestUserMessage, contextEmbeddingProvider);
      const context = buildAoiContextRouterResult({
        sessionsDir,
        sessionPath,
        configFile,
        latestUserMessage,
        queryEmbedding,
        queryEmbeddingModel: contextEmbeddingProvider?.model ?? null,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        context,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/wakeup') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiAutonomyWakeupReason(body.reason)) {
        writeJson(res, 400, {
          error:
            'reason must be one of session_open, user_return_idle, manual_refresh, source_ttl_expired, mission_waiting_too_long, kira_event, research_event, health_check',
          code: 'invalid_wakeup_reason',
        });
        return true;
      }
      const llmConfig =
        body.llmConfig && typeof body.llmConfig === 'object' && !Array.isArray(body.llmConfig)
          ? (body.llmConfig as LLMConfig)
          : undefined;
      const result = await runAoiAutonomyWakeup({
        sessionsDir,
        sessionPath,
        reason: body.reason,
        workspaceRoot,
        configFile,
        latestUserMessage:
          typeof body.latestUserMessage === 'string' ? body.latestUserMessage : undefined,
        llmConfig,
        sourceIds: Array.isArray(body.sourceIds)
          ? body.sourceIds.filter((item): item is string => typeof item === 'string')
          : undefined,
        budget: getWakeupBudgetFromBody(body.budget),
        quietMode: typeof body.quietMode === 'boolean' ? body.quietMode : undefined,
        userIdleMs: typeof body.userIdleMs === 'number' ? body.userIdleMs : undefined,
        ...(typeof body.language === 'string'
          ? { language: normalizeAoiCardLang(body.language) }
          : {}),
      });
      writeJson(res, 200, result);
      return true;
    }

    if (req.method === 'GET' && route === '/proactive-briefs') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(
        res,
        200,
        buildAoiProactiveBriefResponse({
          sessionsDir,
          sessionPath,
        }),
      );
      return true;
    }

    if (req.method === 'POST' && route === '/proactive-briefs/feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const briefId = typeof body.briefId === 'string' ? body.briefId.trim() : '';
      if (!briefId || briefId.length > 127) {
        writeJson(res, 400, {
          error: 'briefId must be a non-empty string no longer than 127 characters.',
          code: 'invalid_brief_id',
        });
        return true;
      }
      if (!isAoiProactiveBriefFeedbackCategory(body.category)) {
        writeJson(res, 400, {
          error: 'Invalid proactive brief feedback category.',
          code: 'invalid_feedback_category',
        });
        return true;
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        writeJson(res, 400, {
          error: 'note must be a string when provided.',
          code: 'invalid_feedback_note',
        });
        return true;
      }
      const policy = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
      const mutation = applyAoiProactiveBriefFeedbackAction({
        sessionsDir,
        sessionPath,
        briefId,
        category: body.category,
        note: typeof body.note === 'string' ? body.note.slice(0, 240) : undefined,
        defaultCooldownMs: policy.defaultCooldownMs,
      });
      writeJson(res, 200, {
        ...buildAoiProactiveBriefResponse({
          sessionsDir,
          sessionPath,
        }),
        feedbackRecord: mutation.feedback,
        candidate: mutation.candidate,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/proactive-briefs/trend-delivery') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId.trim() : '';
      if (!snapshotId || snapshotId.length > 127) {
        writeJson(res, 400, {
          error: 'snapshotId must be a non-empty string no longer than 127 characters.',
          code: 'invalid_snapshot_id',
        });
        return true;
      }
      if (!isAoiProactiveTrendDeliveryEventKind(body.kind)) {
        writeJson(res, 400, {
          error: 'Invalid proactive trend delivery event kind.',
          code: 'invalid_trend_delivery_event_kind',
        });
        return true;
      }
      const now = Date.now();
      const snapshot =
        loadAoiProactiveTrendSnapshots(sessionsDir, sessionPath, now).find(
          (item) => item.id === snapshotId,
        ) ?? null;
      if (!snapshot) {
        writeJson(res, 404, {
          error: 'Proactive trend snapshot was not found.',
          code: 'trend_snapshot_not_found',
        });
        return true;
      }
      const deliveryEvent = recordAoiProactiveTrendDeliveryEventFromSnapshot({
        sessionsDir,
        snapshot,
        kind: body.kind,
        now,
      });
      // P3-2a: an actual direct-chat offer is the real interruption, so charge it against the
      // per-day direct-chat budget here (the scheduler only reads this ledger to downgrade
      // future offers). Best-effort: an accounting failure must not fail the delivery record.
      if (body.kind === 'direct_chat_offered') {
        try {
          const rolled = checkAoiDirectChatBudget({
            state: loadAoiDirectChatBudgetState(sessionsDir, sessionPath),
            sessionPath,
            now,
            windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
            ceilingCalls: 0,
            estimatedCalls: 0,
          }).rolledState;
          saveAoiDirectChatBudgetState(
            sessionsDir,
            sessionPath,
            recordAoiDirectChatOffer(rolled, now, 1),
          );
        } catch {
          // Budget accounting is diagnostic; the delivery event remains authoritative.
        }
      }
      if (snapshot.candidateId && body.kind !== 'delivery_suppressed') {
        try {
          recordAoiProactiveBriefFieldEvent(sessionsDir, {
            sessionPath,
            kind: body.kind === 'direct_chat_offered' ? 'chat_hook_offered' : 'shown_inline',
            briefId: snapshot.candidateId,
            topicId: snapshot.topicId,
            deliveryMode: body.kind === 'direct_chat_offered' ? 'chat_hook' : 'inline_card',
            title: snapshot.title,
            summary: snapshot.delivery.summary,
            sourceRefs: snapshot.sources.map((source) => source.url),
            sourceHosts: snapshot.sources.map((source) => source.host),
            evidenceRefs: [
              `trend-delivery-event:${deliveryEvent.id}`,
              ...snapshot.evidenceRefs.slice(0, 8),
            ],
            freshness: {
              searchedAt: now,
              newestSourceAt:
                snapshot.sources
                  .map((source) => source.publishedAt)
                  .filter((value): value is string => Boolean(value))
                  .sort()
                  .slice(-1)[0] ?? undefined,
              cannotKnow: ['Aoi cannot prove the operator read the surfaced trend.'],
              stale: snapshot.freshness === 'stale',
            },
            dedupeKey: `trend-field:${deliveryEvent.id}`,
            createdAt: now,
          });
        } catch (error) {
          console.warn('[AoiAutonomyPlugin] Failed to record trend field event', error);
        }
      }
      writeJson(res, 200, {
        ...buildAoiProactiveBriefResponse({
          sessionsDir,
          sessionPath,
        }),
        deliveryEvent,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/proactive-briefs/cooldown/reset') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const policy = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
      if (!policy.enabled || !policy.proactiveBriefing.enabled) {
        writeJson(res, 403, {
          error: 'Proactive scout cooldown reset is disabled by policy.',
          code: 'cooldown_reset_policy_blocked',
        });
        return true;
      }
      const now = Date.now();
      const topicId =
        typeof body.topicId === 'string' && body.topicId.trim() ? body.topicId.trim() : undefined;
      const profile = loadAoiInterestProfile(sessionsDir, sessionPath, now);
      const topic = topicId ? profile.topics.find((item) => item.id === topicId) : undefined;
      if (topicId && !topic) {
        writeJson(res, 404, {
          error: 'Proactive brief topic was not found.',
          code: 'topic_not_found',
        });
        return true;
      }
      upsertAoiProactiveBriefCooldown(sessionsDir, sessionPath, {
        cooldownKey: topic?.cooldownKey ?? AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
        ...(topic ? { topicId: topic.id } : {}),
        nextAllowedAt: now,
        reason: 'operator_reset',
        sourceBriefIds: [],
        now,
      });
      writeJson(res, 200, buildAoiProactiveBriefResponse({ sessionsDir, sessionPath }));
      return true;
    }

    if (req.method === 'POST' && route === '/proactive-briefs/scout') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (body.mode !== undefined && body.mode !== 'quick') {
        writeJson(res, 400, {
          error: 'mode must be quick when provided.',
          code: 'invalid_mode',
        });
        return true;
      }
      if (
        body.topicId !== undefined &&
        (typeof body.topicId !== 'string' || body.topicId.trim().length > 120)
      ) {
        writeJson(res, 400, {
          error: 'topicId must be a string no longer than 120 characters when provided.',
          code: 'invalid_topic_id',
        });
        return true;
      }
      const topicId =
        typeof body.topicId === 'string' && body.topicId.trim() ? body.topicId.trim() : undefined;
      const result = await runAoiAutonomyWakeup({
        sessionsDir,
        sessionPath,
        reason: 'manual_refresh',
        workspaceRoot,
        configFile,
        budget: {
          maxSchedulerRuntimeMs: 15_000,
          maxBackgroundTickRuntimeMs: 0,
          maxSourceCount: 0,
          maxGeneratedProposalCount: 0,
          wakeupCooldownMs: 0,
          allowNetwork: true,
        },
        quietMode: body.quietMode === true,
        proactiveScout: {
          runNow: true,
          ...(topicId ? { topicId } : {}),
        },
      });
      writeJson(res, 200, {
        ...result,
        proactiveBriefs: buildAoiProactiveBriefResponse({
          sessionsDir,
          sessionPath,
        }),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/timeline/export') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = typeof body.limit === 'number' ? body.limit : undefined;
      const eventKinds = Array.isArray(body.eventKinds)
        ? body.eventKinds.filter(isAoiOperatorTimelineEventKind)
        : undefined;
      const traceExport = exportAoiOperatorTrace(sessionsDir, sessionPath, {
        limit,
        eventKinds,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        traceExport,
        summary: loadAoiOperatorTimelineSummary(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/voice/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!body.decision || typeof body.decision !== 'object' || Array.isArray(body.decision)) {
        writeJson(res, 400, {
          error: 'Invalid or missing voice decision.',
          code: 'invalid_voice_decision',
        });
        return true;
      }
      const decision = {
        ...(body.decision as AoiVoiceRenderDecision),
        sessionPath,
      };
      const event = recordAoiOperatorVoiceDecisionTimelineEvent({
        sessionsDir,
        sessionPath,
        decision,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        event,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/flight-recorder') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const rawRecord =
        body.record && typeof body.record === 'object' && !Array.isArray(body.record)
          ? (body.record as Record<string, unknown>)
          : body;
      const record = recordAoiOperatorFlightRecord(sessionsDir, {
        ...rawRecord,
        sessionPath,
      });
      recordAoiTimelineBestEffort(() => {
        recordAoiOperatorTimelineEvent(sessionsDir, {
          sessionPath,
          kind: 'observation_ingested',
          visibility: record.decisionLane === 'hidden' ? 'hidden' : 'dashboard_only',
          createdAt: record.createdAt,
          title: 'Operator flight decision recorded',
          summary: `${record.signalClass.replace(/_/g, ' ')} -> ${record.decisionLane.replace(
            /_/g,
            ' ',
          )}; hard fails private=${record.hardFailCounters.privateLeakCount} unauthorized=${record.hardFailCounters.unauthorizedMutationCount} stale=${record.hardFailCounters.staleCurrentClaimCount} approval=${record.hardFailCounters.approvalBypassCount}`,
          sourceRef: `flight-record:${record.id}`,
          sourceKind: 'operator_flight_recorder',
          status: record.decisionLane,
          evidenceRefs: [`flight-record:${record.id}`, ...record.evidenceRefs],
          relatedRefs: record.preparedActionRefs,
          metrics: {
            privateLeakCount: record.hardFailCounters.privateLeakCount,
            unauthorizedMutationCount: record.hardFailCounters.unauthorizedMutationCount,
            staleCurrentClaimCount: record.hardFailCounters.staleCurrentClaimCount,
            approvalBypassCount: record.hardFailCounters.approvalBypassCount,
            mutationCount: record.mutationCount,
          },
        });
      });
      writeJson(res, 200, {
        ...buildAoiOperatorFlightRecorderResponse({
          sessionsDir,
          sessionPath,
        }),
        record,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/flight-recorder/replay-draft') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const recordId = typeof body.recordId === 'string' ? body.recordId : undefined;
      const replayDraft = createAoiOperatorFlightReplayDraft({
        sessionsDir,
        sessionPath,
        recordId,
      });
      writeJson(res, 200, {
        ...buildAoiOperatorFlightRecorderResponse({
          sessionsDir,
          sessionPath,
        }),
        replayDraft,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/policy') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const policy = saveAoiAutonomyPolicy(sessionsDir, sessionPath, body.policy ?? body);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        policy,
      });
      return true;
    }

    // P4.1: memory decay/forgetting operator surface. Store-wide + soft-delete only
    // (status='archived', recoverable). The dry-run is READ-ONLY; apply is gated by a
    // content-addressed approval fingerprint so nothing is ever archived without the
    // operator approving the exact reviewed set; restore is ungated (non-destructive).
    if (req.method === 'GET' && route === '/memory/decay-preview') {
      const dryRun = computeServerAoiMemoryDecayDryRun(sessionsDir, { now: Date.now() });
      writeJson(res, 200, { ok: true, ...dryRun });
      return true;
    }
    // P4.4: read-only embedding-coverage status so the operator can see whether a
    // provider is configured and how many active memories are still lexical-only.
    if (req.method === 'GET' && route === '/memory/embedding-status') {
      const status = loadAoiMemoryEmbeddingStatus(sessionsDir, { configFile });
      writeJson(res, 200, { ok: true, ...status });
      return true;
    }
    if (req.method === 'POST' && route === '/memory/explicit-correction') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      const memoryId = getOptionalBodyString(body.memoryId)?.slice(0, 128) ?? '';
      const expectedContentSha256 =
        getOptionalBodyString(body.expectedContentSha256)?.toLowerCase() ?? '';
      const correctedContent = getOptionalBodyString(body.correctedContent) ?? '';
      const sourceChatRef = getOptionalBodyString(body.sourceChatRef)?.slice(0, 180) ?? '';
      const correctionId = getOptionalBodyString(body.correctionId)?.slice(0, 128) ?? '';
      if (
        !sessionPath ||
        !memoryId ||
        !correctedContent ||
        !sourceChatRef.startsWith('chat:') ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(correctionId) ||
        correctionId.includes('..') ||
        !/^[a-f0-9]{64}$/u.test(expectedContentSha256) ||
        body.userConfirmed !== true
      ) {
        writeJson(res, 400, {
          error:
            'A session-bound memoryId, expected SHA-256, correctedContent, sourceChatRef, correctionId, and userConfirmed=true are required.',
          code: 'invalid_memory_correction',
        });
        return true;
      }
      try {
        const now = Date.now();
        const episodeId = `aoi_ep_correction_${createHash('sha256')
          .update(correctionId, 'utf-8')
          .digest('hex')
          .slice(0, 24)}`;
        saveServerAoiMemoryEpisode(sessionsDir, sessionPath, {
          id: episodeId,
          source: 'manual_memory',
          userMessage: 'User supplied an explicit memory correction.',
          assistantMessage: `Applied explicit correction ${correctionId} to memory ${memoryId}.`,
          toolCalls: ['save_memory'],
          createdAt: now,
          outcome: 'memory_corrected',
        });
        const correction = updateServerAoiMemoryFromExplicitCorrection(sessionsDir, {
          sessionPath,
          memoryId,
          expectedContentSha256,
          correctedContent,
          episodeId,
          now,
        });
        const correctionRef = `memory-correction:${correctionId}`;
        const outcome = appendAoiOutcomeSignalRecord(
          sessionsDir,
          {
            eventId: correctionRef,
            sessionPath,
            outcomeKind: 'user_correction',
            signalKind: 'explicit_correction',
            sourceChatRef,
            explicitLabel: 'user_memory_correction',
            topicKey: 'memory_personalization',
            sourceKey: `memory:${memoryId}`,
            result: 'negative',
            privacyState: 'metadata_only',
            evidenceRefs: [
              correctionRef,
              `memory:${memoryId}`,
              `memory-episode:${episodeId}`,
              `memory-before-sha256:${correction.previousContentSha256}`,
              `memory-after-sha256:${correction.correctedContentSha256}`,
              sourceChatRef,
            ],
            createdAt: now,
          },
          now,
        );
        recordAoiTimelineBestEffort(() => {
          recordAoiOutcomeSignalTimelineEvent({ sessionsDir, outcome });
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          correction: {
            id: correctionId,
            memoryId,
            changed: correction.changed,
            previousContentSha256: correction.previousContentSha256,
            correctedContentSha256: correction.correctedContentSha256,
            episodeId,
            updatedAt: correction.memory.updatedAt,
            outcomeId: outcome.id,
          },
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'memory_correction_blocked',
        });
      }
      return true;
    }
    // P5.3: surface the (previously dark) unified operator model, built from the real
    // server stores. Serves the display_only summary; strictly read-only.
    if (req.method === 'GET' && route === '/operator/unified-snapshot') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const summary = loadAoiUnifiedOperatorSummaryFromStores(sessionsDir, {
        sessionPath,
        now: Date.now(),
      });
      writeJson(res, 200, { ok: true, sessionPath, summary });
      return true;
    }
    // P5.4: read-only trust on-ramp readiness accrual (sample count -> directChatReady +
    // blockers) so the operator can see the trust ladder progress.
    if (req.method === 'GET' && route === '/operator/readiness-accrual') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const readiness = loadAoiProactiveTrendReadinessFromStores(sessionsDir, {
        sessionPath,
        now: Date.now(),
      });
      writeJson(res, 200, { ok: true, sessionPath, readiness });
      return true;
    }
    if (req.method === 'GET' && route === '/operator/non-voice-scorecard') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const evidenceClass = url.searchParams.get('evidenceClass');
      if (
        evidenceClass !== 'synthetic' &&
        evidenceClass !== 'controlled_real' &&
        evidenceClass !== 'live_field'
      ) {
        writeJson(res, 400, {
          error: 'Invalid or missing evidenceClass.',
          code: 'invalid_evidence_class',
        });
        return true;
      }
      const now = Date.now();
      const scorecard = loadAoiNonVoiceJarvisScorecardFromStores({
        sessionsDir,
        sessionPath,
        evidenceClass,
        configFile,
        now,
        daemonHealth: getDaemonHealthSnapshot?.(now) ?? null,
        currentCodeFingerprint: resolveAoiWorkspaceCodeFingerprint(workspaceRoot),
      });
      writeJson(res, 200, { ok: true, sessionPath, evidenceClass, scorecard });
      return true;
    }
    if (req.method === 'POST' && route === '/memory/decay-apply') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(
        (id): id is string => typeof id === 'string',
      );
      const approvalFingerprint =
        typeof body.approvalFingerprint === 'string' ? body.approvalFingerprint : '';
      const result = archiveServerAoiMemories(sessionsDir, ids, { approvalFingerprint });
      if (result.rejected) {
        // The reviewed set drifted (fingerprint mismatch) -- nothing was written.
        writeJson(res, 409, {
          ok: false,
          sessionPath,
          rejected: true,
          code: 'decay_approval_mismatch',
        });
        return true;
      }
      // Audit trail for the destructive-adjacent op (best-effort; never blocks it).
      if (result.archivedCount > 0) {
        try {
          recordServerAoiRunLedgerEvent({
            sessionsDir,
            sessionPath,
            type: 'memory_archived',
            message: `Archived ${result.archivedCount} memory(ies) via operator-approved decay.`,
            goalSummary: 'Aoi memory decay (archive)',
            toolNames: ['memory_decay'],
            status: 'completed',
          });
        } catch {
          // best-effort audit
        }
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        archivedCount: result.archivedCount,
        changedIds: result.changedIds,
      });
      return true;
    }
    if (req.method === 'POST' && route === '/memory/decay-restore') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(
        (id): id is string => typeof id === 'string',
      );
      const result = unarchiveServerAoiMemories(sessionsDir, ids);
      if (result.unarchivedCount > 0) {
        try {
          recordServerAoiRunLedgerEvent({
            sessionsDir,
            sessionPath,
            type: 'memory_restored',
            message: `Restored ${result.unarchivedCount} archived memory(ies).`,
            goalSummary: 'Aoi memory decay (restore)',
            toolNames: ['memory_decay'],
            status: 'completed',
          });
        } catch {
          // best-effort audit
        }
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        unarchivedCount: result.unarchivedCount,
        changedIds: result.changedIds,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/sources') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
      const patch =
        body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
          ? body.patch
          : {};
      try {
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          registry: updateAoiEnvironmentSource(sessionsDir, sessionPath, {
            sourceId,
            patch,
          }),
          status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'source_not_found' : 'invalid_source_update',
        });
      }
      return true;
    }

    if (req.method === 'GET' && route === '/activity') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // SA1.2: read-only, display-only activity summary. The loader itself is
      // consent-gated (fail-closed) -- a non-consented source yields an empty
      // summary carrying an explicit cannotKnow statement, never data.
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        summary: loadAoiActivityStreamSummary(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/intent') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // SA2.2: read-only, display-only current-intent state persisted by the
      // tick. Stale is surfaced explicitly so consumers never treat an old
      // inference as "now".
      const intent = loadAoiIntentState(sessionsDir, sessionPath);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        intent,
        stale: intent ? intent.staleAt <= Date.now() : null,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/situation') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // SA4.2: read-only, display-only current-situation brief persisted by the
      // tick. Staleness is explicit so consumers never present an old fusion
      // as "now".
      const situation = loadAoiCurrentSituation(sessionsDir, sessionPath);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        situation,
        stale: situation ? situation.staleAt <= Date.now() : null,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/cognition-readiness') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // SA5.2: read-only grounding-accuracy scorecard assembled from the real
      // stores. Display-only; consumers may use it only to hold trust.
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        scorecard: buildAoiServerCognitionReadinessScorecard({
          sessionsDir,
          sessionPath,
          now: Date.now(),
        }),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/activity/event') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // SA1.2: metadata-only capture. recordAoiActivityEvent enforces the
      // app-activity consent gate server-side and derives the stored summary
      // from validated slugs -- request free text never enters the store.
      const result = recordAoiActivityEvent(sessionsDir, sessionPath, {
        kind: body.kind,
        appId: body.appId,
        actionType: body.actionType,
        observedAt: typeof body.observedAt === 'number' ? body.observedAt : undefined,
      });
      if (!result.recorded) {
        const blockedByConsent = result.reasons.some(
          (reason) =>
            reason === 'source_disabled' ||
            reason === 'explicit_target_scope_required' ||
            reason === 'source_consent_review_required' ||
            reason === 'registry_unreadable' ||
            reason.startsWith('operation_not_allowed'),
        );
        writeJson(res, blockedByConsent ? 403 : 400, {
          error: 'Activity event was not recorded.',
          code: blockedByConsent ? 'activity_source_blocked' : 'invalid_activity_event',
          reasons: result.reasons,
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        event: result.event,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/context/browser') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const urlValue = typeof body.url === 'string' ? body.url : '';
      if (!urlValue.trim()) {
        writeJson(res, 400, {
          error: 'url is required.',
          code: 'invalid_browser_context',
        });
        return true;
      }
      const context = recordAoiBrowserContextMetadata({
        sessionsDir,
        sessionPath,
        pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle : 'Untitled page',
        url: urlValue,
        purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
        capturedAt: typeof body.capturedAt === 'number' ? body.capturedAt : undefined,
      });
      const routerContext = buildAoiContextRouterResult({
        sessionsDir,
        sessionPath,
        configFile,
      });
      recordAoiTimelineBestEffort(() => {
        for (const event of buildAoiContextRouterTimelineEvents(routerContext)) {
          recordAoiOperatorTimelineEvent(sessionsDir, event);
        }
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        browserContext: context,
        context: routerContext,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/context/feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const feedback = recordAoiContextSourceFeedback({
          sessionsDir,
          sessionPath,
          sourceId: typeof body.sourceId === 'string' ? body.sourceId : '',
          contextSummaryId:
            typeof body.contextSummaryId === 'string' ? body.contextSummaryId : undefined,
          feedbackCategory: body.feedbackCategory as AoiProposalFeedbackCategory,
          feedbackNote: typeof body.feedbackNote === 'string' ? body.feedbackNote : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
        });
        const routerContext = buildAoiContextRouterResult({
          sessionsDir,
          sessionPath,
          configFile,
        });
        recordAoiTimelineBestEffort(() => {
          recordAoiOperatorTimelineEvent(sessionsDir, {
            sessionPath,
            kind: 'feedback_recorded',
            visibility: 'operator_visible',
            createdAt: feedback.createdAt,
            title: 'Context source feedback recorded',
            summary: `Feedback category ${feedback.feedbackCategory} recorded for source ${feedback.sourceId}.`,
            sourceRef: feedback.contextSummaryId
              ? `context-source:${feedback.contextSummaryId}`
              : `environment-source:${feedback.sourceId}`,
            sourceKind: feedback.sourceId,
            evidenceRefs: feedback.evidenceRefs,
            relatedRefs: [
              `environment-source:${feedback.sourceId}`,
              ...(feedback.contextSummaryId ? [`context-source:${feedback.contextSummaryId}`] : []),
            ],
            metadata: {
              feedbackCategory: feedback.feedbackCategory,
            },
          });
          for (const event of buildAoiContextRouterTimelineEvents(routerContext)) {
            recordAoiOperatorTimelineEvent(sessionsDir, event);
          }
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          feedback,
          context: routerContext,
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_context_feedback',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/workspace/validation') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const result = body.result;
      if (result !== 'unknown' && result !== 'passed' && result !== 'failed') {
        writeJson(res, 400, {
          error: 'result must be one of unknown, passed, failed',
          code: 'invalid_validation_result',
        });
        return true;
      }
      const snapshot = recordAoiValidationSignal({
        sessionsDir,
        sessionPath,
        signal: {
          result,
          command: typeof body.command === 'string' ? body.command : undefined,
          completedAt: typeof body.completedAt === 'number' ? body.completedAt : Date.now(),
          touchedFileScopes: Array.isArray(body.touchedFileScopes)
            ? body.touchedFileScopes.filter((item): item is string => typeof item === 'string')
            : [],
        },
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        snapshot,
        status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/mission/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const action = body.action;
      if (
        action !== 'pause' &&
        action !== 'resume' &&
        action !== 'clear' &&
        action !== 'complete' &&
        action !== 'block'
      ) {
        writeJson(res, 400, {
          error: 'action must be one of pause, resume, clear, complete, block',
          code: 'invalid_mission_decision_action',
        });
        return true;
      }
      try {
        const mission = applyAoiMissionDecision(sessionsDir, sessionPath, {
          action,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          mission,
          status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'blocked_mission_transition',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/tick') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiAutonomyTickReason(body.reason)) {
        writeJson(res, 400, {
          error:
            'reason must be one of manual, turn, periodic, research_run, kira, proposal, memory, app',
          code: 'invalid_tick_reason',
        });
        return true;
      }
      const llmConfig =
        body.llmConfig && typeof body.llmConfig === 'object' && !Array.isArray(body.llmConfig)
          ? (body.llmConfig as LLMConfig)
          : undefined;
      const result = await runAoiAutonomyBackgroundTick({
        sessionsDir,
        sessionPath,
        reason: body.reason,
        latestUserMessage:
          typeof body.latestUserMessage === 'string' ? body.latestUserMessage : undefined,
        llmConfig,
        maxRuntimeMs: typeof body.maxRuntimeMs === 'number' ? body.maxRuntimeMs : undefined,
        quietMode: typeof body.quietMode === 'boolean' ? body.quietMode : undefined,
        userIdleMs: typeof body.userIdleMs === 'number' ? body.userIdleMs : undefined,
        ...(typeof body.language === 'string'
          ? { language: normalizeAoiCardLang(body.language) }
          : {}),
        workspaceRoot,
      });
      writeJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && route === '/goal/check') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const result = updateAoiGoalProgressFromObservations({
        sessionsDir,
        sessionPath,
        observations: loadAoiObservations(sessionsDir, sessionPath),
        activeProposals: loadAoiActiveProposals(sessionsDir, sessionPath),
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: result.activeGoals,
        archived: result.archivedGoals,
        progress: result.events,
        status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/goal/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const action = body.action;
      try {
        if (action === 'accept') {
          const result = applyAoiProposalDecision(sessionsDir, sessionPath, {
            proposalId: String(body.proposalId ?? ''),
            action: 'accept',
            actor: 'user',
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          });
          const goal = activateAoiGoalFromProposal({
            sessionsDir,
            sessionPath,
            proposal: result.proposal,
          });
          recordAoiTimelineBestEffort(() => {
            recordAoiProposalDecisionTimelineEvent({
              sessionsDir,
              proposal: result.proposal,
              decision: result.decision,
            });
          });
          writeJson(res, 200, {
            ok: true,
            sessionPath,
            proposal: result.proposal,
            decision: result.decision,
            goal,
            active: loadAoiActiveGoals(sessionsDir, sessionPath),
            archived: loadAoiArchivedGoals(sessionsDir, sessionPath),
          });
          return true;
        }
        if (
          action !== 'pause' &&
          action !== 'resume' &&
          action !== 'abandon' &&
          action !== 'complete' &&
          action !== 'block'
        ) {
          writeJson(res, 400, {
            error: 'action must be one of accept, pause, resume, abandon, complete, block',
            code: 'invalid_goal_decision_action',
          });
          return true;
        }
        const goal = applyAoiGoalDecision(sessionsDir, sessionPath, {
          goalId: String(body.goalId ?? ''),
          action,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
          userConfirmed: body.userConfirmed === true,
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          goal,
          active: loadAoiActiveGoals(sessionsDir, sessionPath),
          archived: loadAoiArchivedGoals(sessionsDir, sessionPath),
          status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'goal_not_found' : 'blocked_goal_transition',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const action = body.action;
      if (action !== 'accept' && action !== 'dismiss' && action !== 'snooze') {
        writeJson(res, 400, {
          error: 'action must be one of accept, dismiss, snooze',
          code: 'invalid_decision_action',
        });
        return true;
      }
      try {
        const result = applyAoiProposalDecision(sessionsDir, sessionPath, {
          proposalId: String(body.proposalId ?? ''),
          action,
          actor: body.actor === 'system' ? 'system' : 'user',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          feedbackCategory: body.feedbackCategory,
          feedbackNote: body.feedbackNote,
          snoozeMs: typeof body.snoozeMs === 'number' ? body.snoozeMs : undefined,
        });
        const goal =
          action === 'accept'
            ? activateAoiGoalFromProposal({
                sessionsDir,
                sessionPath,
                proposal: result.proposal,
              })
            : null;
        recordAoiTimelineBestEffort(() => {
          recordAoiProposalDecisionTimelineEvent({
            sessionsDir,
            proposal: result.proposal,
            decision: result.decision,
          });
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          proposal: result.proposal,
          decision: result.decision,
          goal,
          active: result.activeProposals,
          archived: result.archivedProposals,
          executed: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'proposal_not_found' : 'blocked_transition',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const decision = applyAoiProposalFeedback(sessionsDir, sessionPath, {
          decisionId: String(body.decisionId ?? ''),
          feedbackCategory: body.feedbackCategory,
          feedbackNote: body.feedbackNote,
        });
        recordAoiTimelineBestEffort(() => {
          recordAoiProposalFeedbackTimelineEvent({
            sessionsDir,
            decision,
          });
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          decision,
          evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'decision_not_found' : 'invalid_feedback',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/preview') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const result = previewAoiProposal({
          sessionsDir,
          sessionPath,
          proposalId: String(body.proposalId ?? ''),
        });
        writeJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          ok: false,
          error: message,
          code: statusCode === 404 ? 'proposal_not_found' : 'preview_failed',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/execute') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const result = await executeAoiProposal({
          sessionsDir,
          configFile,
          serverOrigin: getRequestOrigin(req),
          workspaceRoot,
          sessionPath,
          proposalId: String(body.proposalId ?? ''),
          decisionId: typeof body.decisionId === 'string' ? body.decisionId : undefined,
        });
        writeJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          ok: false,
          error: message,
          code: statusCode === 404 ? 'proposal_not_found' : 'execution_failed',
        });
      }
      return true;
    }

    writeJson(res, 404, { error: 'Unknown Aoi autonomy route.', code: 'unknown_route' });
    return true;
  } catch (error) {
    writeJson(res, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof SyntaxError ? 'invalid_json' : 'internal_error',
    });
    return true;
  }
}

// A Connect-style request handler that owns the Aoi autonomy API routes and
// calls next() for anything it does not handle. Shared by the Vite plugin and
// the standalone daemon so the routing glue has a single implementation and is
// never forked. Path resolution happens once when the middleware is created.
export type AoiAutonomyMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export function createAoiAutonomyMiddleware(
  options: AoiAutonomyPluginOptions,
): AoiAutonomyMiddleware {
  const sessionsDir = resolve(options.sessionsDir);
  const configFile = resolve(options.configFile);
  const workspaceRoot = resolve(options.workspaceRoot || process.cwd());
  return (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    void handleAoiAutonomyRequest(
      req,
      res,
      url,
      sessionsDir,
      configFile,
      workspaceRoot,
      options.getDaemonHealthSnapshot,
    )
      .then((handled) => {
        if (!handled) {
          next();
        }
      })
      .catch((error) => {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
  };
}

// Start the self-initiating background autonomy loop from env config. This is
// what lets Aoi "wake itself up" instead of only ticking on an inbound request.
// Returns null when the loop is NOT opted in (AOI_AUTONOMY_BACKGROUND unset),
// so a caller stays loop-free by default. Lifecycle (stop on shutdown) is the
// caller's responsibility. Shared by the Vite plugin and the standalone daemon
// so the loop wiring is never forked.
export function startAoiAutonomyBackgroundFromEnv(
  options: AoiAutonomyPluginOptions,
  env: Record<string, string | undefined> = process.env,
  {
    defaultStart = false,
    runImmediately = false,
    onCycle,
    onError,
  }: {
    defaultStart?: boolean;
    runImmediately?: boolean;
    // Observability hooks (used by the daemon health tracker). Optional so the
    // Vite plugin path is unchanged.
    onCycle?: (result: AoiAutonomyBackgroundCycleResult) => void;
    onError?: (error: unknown) => void;
  } = {},
): AoiAutonomyBackgroundRunnerHandle | null {
  const backgroundConfig = resolveAoiAutonomyBackgroundConfigFromEnv(env);
  // defaultStart hosts (the standalone daemon) run the loop unless AOI_AUTONOMY_BACKGROUND
  // is EXPLICITLY off, so the operator controls on/off from the settings UI (per-session
  // policy.enabled, default false -> a safe idle no-op) without touching env. The Vite
  // plugin keeps the opt-in default (start only when explicitly enabled) so an ordinary
  // dev server never starts an autonomy loop. AOI_AUTONOMY_BACKGROUND=0 is a hard ceiling
  // either way.
  const raw = env.AOI_AUTONOMY_BACKGROUND;
  const explicitlyOff = raw === '0' || raw === 'false' || raw === 'no';
  const shouldStart = defaultStart ? !explicitlyOff : backgroundConfig.enabled;
  if (!shouldStart) {
    return null;
  }
  const sessionsDir = resolve(options.sessionsDir);
  const configFile = resolve(options.configFile);
  const workspaceRoot = resolve(options.workspaceRoot || process.cwd());
  // Single-instance guard: refuse to start a SECOND loop against the same
  // session dir (double-tick / file races; the in-flight guard is per-process).
  // This covers daemon-vs-daemon AND daemon-vs-Vite because both mounts start
  // the loop through this one function. OFF-by-default is preserved: the lock
  // is only touched after the enabled check above, so an un-opted-in process
  // never writes the lock file.
  const loopLock = acquireAoiAutonomyLoopLock(sessionsDir);
  if (!loopLock) {
    return null;
  }
  const runnerHandle = startAoiAutonomyBackgroundRunner({
    sessionsDir,
    configFile,
    workspaceRoot,
    intervalMs: backgroundConfig.intervalMs,
    runImmediately,
    allowNetworkCeiling: backgroundConfig.allowNetworkCeiling,
    maxSessionsPerCycle: backgroundConfig.maxSessionsPerCycle,
    maxCycleRuntimeMs: backgroundConfig.maxCycleRuntimeMs,
    maxBackgroundTickRuntimeMs: backgroundConfig.maxBackgroundTickRuntimeMs,
    llmDailyTokenBudget: backgroundConfig.llmDailyTokenBudget,
    goalSynthesisEnabled: backgroundConfig.goalSynthesisEnabled,
    scoutNetworkDailyBudget: backgroundConfig.scoutNetworkDailyBudget,
    directChatDailyBudget: backgroundConfig.directChatDailyBudget,
    idleConfidenceSurgeEnabled: backgroundConfig.idleConfidenceSurgeEnabled,
    // Resolve the user's main model from the config file so the background
    // loop can drive LLM reasoning (only used when allowNetwork is on).
    loadLlmConfig: () => loadAoiMainLlmConfig(configFile),
    ...(onCycle ? { onCycle } : {}),
    ...(onError ? { onError } : {}),
  });
  // Release the lock when the loop stops so a clean shutdown frees the dir for
  // the next process (a crash leaves a stale lock that the next acquire reclaims).
  return {
    stop: () => {
      runnerHandle.stop();
      loopLock.release();
    },
  };
}

// Start the loop-independent memory maintenance sweep (embed + consolidation) from
// env config. Returns null when NEITHER half is opted in (AOI_AUTONOMY_EMBED_SWEEP
// and AOI_AUTONOMY_CONSOLIDATION both unset). Shared by the Vite plugin and the
// standalone daemon so the wiring is never forked. It REUSES the single-instance
// loop lock: whichever process owns the dir runs the maintenance, so the sweep and
// the autonomy tick's own backfill/consolidation never both mutate the memory files.
// Because the caller starts the background loop FIRST, an enabled loop already holds
// the lock (its tick covers embedding + consolidation) and this returns null; the
// sweep only takes over when the loop is off. Only touched after the enabled check
// -> OFF-by-default never writes the lock file.
export function startAoiMemoryEmbedSweepFromEnv(
  options: AoiAutonomyPluginOptions,
  env: Record<string, string | undefined> = process.env,
): AoiMemoryEmbedSweepHandle | null {
  const sweepConfig = resolveAoiMemoryEmbedSweepConfigFromEnv(env);
  const consolidationConfig = resolveAoiMemoryConsolidationConfigFromEnv(env);
  if (!sweepConfig.enabled && !consolidationConfig.enabled) {
    return null;
  }
  const sessionsDir = resolve(options.sessionsDir);
  const configFile = resolve(options.configFile);
  const loopLock = acquireAoiAutonomyLoopLock(sessionsDir);
  if (!loopLock) {
    return null;
  }
  const sweepHandle = startAoiMemoryEmbedSweep({
    sessionsDir,
    configFile,
    intervalMs: sweepConfig.intervalMs,
    max: sweepConfig.max,
    consolidation: { enabled: consolidationConfig.enabled, max: consolidationConfig.max },
  });
  return {
    stop: () => {
      sweepHandle.stop();
      loopLock.release();
    },
  };
}

export function aoiAutonomyPlugin(options: AoiAutonomyPluginOptions): Plugin {
  const middleware = createAoiAutonomyMiddleware(options);

  // Background autonomy loop + the loop-independent memory embed sweep are started
  // once and stopped on server close. Both are OFF unless opted in via env (each
  // *FromEnv returns null otherwise). The loop is started FIRST so that when both
  // are enabled it holds the single-instance lock and the sweep no-ops (the loop's
  // tick backfill already embeds); the sweep only runs when the loop is off.
  let backgroundHandle: AoiAutonomyBackgroundRunnerHandle | null = null;
  let sweepHandle: AoiMemoryEmbedSweepHandle | null = null;
  let lifecycleBound = false;
  const startBackground = (
    httpServer: { on?: (event: string, listener: () => void) => void } | null | undefined,
  ): void => {
    if (lifecycleBound) {
      return;
    }
    backgroundHandle = startAoiAutonomyBackgroundFromEnv(options);
    sweepHandle = startAoiMemoryEmbedSweepFromEnv(options);
    if (!backgroundHandle && !sweepHandle) {
      return;
    }
    lifecycleBound = true;
    httpServer?.on?.('close', () => {
      backgroundHandle?.stop();
      backgroundHandle = null;
      sweepHandle?.stop();
      sweepHandle = null;
    });
  };

  return {
    name: 'aoi-autonomy',
    configureServer(server) {
      server.middlewares.use(middleware);
      startBackground(server.httpServer);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      startBackground(server.httpServer);
    },
  };
}
