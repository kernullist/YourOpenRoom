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
import {
  acquireAoiAutonomyLoopLock,
  createAoiAutonomyLoopLockKeeper,
  isAoiAutonomyLoopLockHeldByThisProcess,
} from './aoiAutonomyLoopLock';
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
  runAoiMemoryMaintenanceCycle,
  runAoiMemoryMaintenancePass,
  runSerializedAoiMemoryMaintenance,
  startAoiMemoryEmbedSweep,
  type AoiMemoryEmbedSweepCycleResult,
  type AoiMemoryEmbedSweepHandle,
} from './aoiMemoryEmbedSweep';
import type { AoiMemoryConsolidationSweepCycleResult } from './aoiMemoryConsolidationSweep';
import {
  loadAoiMemoryMaintenanceSettings,
  writeAoiMemoryMaintenanceConfigToFile,
} from './aoiMemoryMaintenanceSettings';
import {
  normalizeAoiAutonomyCapabilitiesConfig,
  normalizeAoiMemoryMaintenanceConfig,
  type AoiAutonomyCapabilitiesConfig,
  type AoiMemoryMaintenanceConfig,
} from './configPersistence';
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
  listAoiAutonomySessionSummaries,
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
import {
  applyAoiRelationshipMilestones,
  loadAoiRelationshipState,
  markAoiRelationshipThreadAsked,
  recordAoiRelationshipArcCompletion,
  recordAoiRelationshipMood,
  recordAoiRelationshipSessionOpen,
  recordAoiRelationshipSessionSummary,
} from './aoiRelationshipState';
import { deriveAoiMoodState, type AoiHabitMomentum } from './aoiMoodState';
import { isHabitDayKey, loadHabitMomentumForSession } from './habitGardenMomentum';
import { deriveAoiRelationshipMilestones } from './aoiRelationshipMilestones';
import {
  loadAoiWeeklyRetrospective,
  loadAoiWeeklyRetrospectiveHistory,
  maybeBuildAoiWeeklyRetrospective,
} from './aoiWeeklyRetrospectiveStore';
import { buildAoiServerCognitionReadinessScorecard } from './aoiCognitionReadinessServer';
import { loadAoiNonVoiceJarvisScorecardFromStores } from './aoiNonVoiceJarvisScorecardServer';
import type { AoiDaemonHealthSnapshot } from './aoiDaemonHealth';
import { resolveAoiWorkspaceCodeFingerprint } from './aoiWorkspaceCodeFingerprint';
import { embedAoiQuery } from './aoiMemoryEmbedding';
import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import {
  loadAoiAutonomyCapabilitySettings,
  writeAoiAutonomyCapabilitiesConfigToFile,
} from './aoiAutonomyCapabilitySettings';
import { describeAoiEnvOnlyAutonomyGates } from './aoiAutonomyEnvOnlyGates';
// Import the model id from the pure core, never from aoiLocalEmbedding: that one
// pulls node:crypto in and has broken the client bundle here before.
import { AOI_LOCAL_EMBEDDING_MODEL } from './aoiLocalEmbeddingCore';
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
    // The bootstrap route: deliberately takes NO sessionPath. Every other route
    // here requires one, which leaves an operator surface running in an app
    // iframe with no way in -- it cannot read the host's in-process sessionPath
    // holder, and vibe-info carries no mod id. Asking for a sessionPath to learn
    // the sessionPaths would be circular, so this one answers cold.
    //
    // Zero sessions is a legitimate answer (nothing has initialized an autonomy
    // store yet), NOT an error: returning 4xx here would make a fresh install
    // look broken to the very console meant to diagnose it.
    if (req.method === 'GET' && route === '/sessions') {
      writeJson(res, 200, {
        ok: true,
        sessions: listAoiAutonomySessionSummaries(sessionsDir),
      });
      return true;
    }

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
    // Memory maintenance settings, owned by the settings UI. These were env-var
    // only, which meant editing system environment variables and restarting the
    // server just to turn semantic memory on.
    if (req.method === 'GET' && route === '/memory/maintenance') {
      const settings = loadAoiMemoryMaintenanceSettings({ configFile });
      const status = loadAoiMemoryEmbeddingStatus(sessionsDir, { configFile });
      writeJson(res, 200, { ok: true, settings, status });
      return true;
    }
    if (req.method === 'POST' && route === '/memory/maintenance') {
      const body = await readJsonBody(req);
      const normalized = normalizeAoiMemoryMaintenanceConfig(
        body as Partial<AoiMemoryMaintenanceConfig>,
      );
      // Clearing the block hands every toggle back to the environment, which
      // can silently RE-ENABLE a feature the operator explicitly turned off, so
      // it needs its own signal. An empty or misspelled body used to normalize
      // to null and wipe the settings with a 200.
      const clearRequested = (body as { clear?: unknown }).clear === true;
      if (!normalized && !clearRequested) {
        writeJson(res, 400, {
          error:
            'Provide at least one maintenance field, or {"clear":true} to fall back to environment variables.',
          code: 'invalid_maintenance_settings',
        });
        return true;
      }
      try {
        writeAoiMemoryMaintenanceConfigToFile(configFile, normalized);
      } catch (error) {
        writeJson(res, 500, {
          error: error instanceof Error ? error.message : 'Failed to save maintenance settings.',
          code: 'maintenance_save_failed',
        });
        return true;
      }
      const settings = loadAoiMemoryMaintenanceSettings({ configFile });
      const status = loadAoiMemoryEmbeddingStatus(sessionsDir, { configFile });
      writeJson(res, 200, { ok: true, settings, status });
      return true;
    }
    // Autonomy capability settings, owned by the settings UI. Like the block
    // above, these were env-var only: the Autonomy panel showed a configurable
    // system whose capabilities could only be turned on by editing system
    // environment variables and restarting.
    if (req.method === 'GET' && route === '/capabilities') {
      writeJson(res, 200, {
        ok: true,
        // Identifies WHICH config.json these settings came from, so a caller
        // relaying this answer can refuse to show it as its own when the two
        // processes are pointed at different stores. Hashed rather than the raw
        // path: the check only needs equality.
        storeId: aoiCapabilityStoreId(configFile, sessionsDir),
        settings: loadAoiAutonomyCapabilitySettings({ configFile }),
        envOnly: describeAoiEnvOnlyAutonomyGates(process.env),
      });
      return true;
    }
    if (req.method === 'POST' && route === '/capabilities') {
      // This route grants self-execute and sets an outbound push URL, so it must
      // not be reachable as a cross-site "simple request". Requiring a JSON
      // content type forces a preflight, and a cross-origin Origin is refused
      // outright: without either, any page the operator visits could POST here.
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().includes('application/json')) {
        writeJson(res, 415, {
          error: 'Capability settings must be sent as application/json.',
          code: 'unsupported_media_type',
        });
        return true;
      }
      if (!isSameOriginRequest(req)) {
        writeJson(res, 403, {
          error: 'Cross-origin capability writes are refused.',
          code: 'cross_origin_forbidden',
        });
        return true;
      }
      const body = await readJsonBody(req);
      const normalized = normalizeAoiAutonomyCapabilitiesConfig(
        body as Partial<AoiAutonomyCapabilitiesConfig>,
      );
      // Clearing the block hands every capability back to the environment, which
      // can silently RE-ENABLE something the operator turned off, so it needs its
      // own signal rather than being what an empty or misspelled body does.
      const clearRequested = (body as { clear?: unknown }).clear === true;
      if (!normalized && !clearRequested) {
        writeJson(res, 400, {
          error:
            'Provide at least one capability field, or {"clear":true} to fall back to environment variables.',
          code: 'invalid_capability_settings',
        });
        return true;
      }
      // A webhook URL the normalizer rejected is dropped rather than stored. Say
      // so instead of answering 200 with the old value still in place, which
      // reads as "saved" for an outbound target that was never accepted.
      const requestedWebhook = (body as { pushWebhookUrl?: unknown }).pushWebhookUrl;
      if (
        typeof requestedWebhook === 'string' &&
        requestedWebhook.trim().length > 0 &&
        normalized?.pushWebhookUrl === undefined
      ) {
        writeJson(res, 400, {
          error: 'Push webhook must be an http(s) URL.',
          code: 'invalid_push_webhook_url',
        });
        return true;
      }
      try {
        writeAoiAutonomyCapabilitiesConfigToFile(configFile, normalized);
      } catch (error) {
        writeJson(res, 500, {
          error: error instanceof Error ? error.message : 'Failed to save capability settings.',
          code: 'capability_save_failed',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        settings: loadAoiAutonomyCapabilitySettings({ configFile }),
        envOnly: describeAoiEnvOnlyAutonomyGates(process.env),
      });
      return true;
    }
    // Run one bounded maintenance pass right now. This is what makes the UI
    // toggle usable immediately: the periodic sweep only starts with the server,
    // so without this the operator would still be waiting for a restart.
    //
    // It mutates the same memory files as the loop and the sweep, so it obeys the
    // same single-instance rule. This route is served by BOTH the dev server and
    // the daemon, and pressing the button in one while the other was mid-pass was
    // the one maintenance path that could still write concurrently. When this
    // process already owns the dir (its own loop or sweep holds the lock) the
    // pass just runs -- serialized in-process by runAoiMemoryMaintenanceCycle.
    if (req.method === 'POST' && route === '/memory/maintenance/run') {
      const settings = loadAoiMemoryMaintenanceSettings({ configFile });
      let embed: AoiMemoryEmbedSweepCycleResult = {
        ran: false,
        embeddedCount: 0,
        pendingCount: 0,
      };
      let consolidation: AoiMemoryConsolidationSweepCycleResult = {
        ran: false,
        clusterCount: 0,
        supersededCount: 0,
      };
      // The lock is taken INSIDE the queue, not before it. Taken outside, a
      // second request arriving while the first held it would see this process's
      // own record, conclude "already ours", skip acquiring -- and then run its
      // whole pass after the first released, with no lock at all.
      const ran = await runSerializedAoiMemoryMaintenance(sessionsDir, async () => {
        const alreadyOurs = isAoiAutonomyLoopLockHeldByThisProcess(sessionsDir);
        const lock = alreadyOurs
          ? null
          : acquireAoiAutonomyLoopLock(sessionsDir, { role: 'maintenance', quiet: true });
        if (!alreadyOurs && !lock) {
          return false;
        }
        try {
          await runAoiMemoryMaintenancePass({
            sessionsDir,
            configFile,
            embedSweep: settings.embedSweep,
            consolidation: settings.consolidation,
            // The authoritative loop may take the lock over while the embed half
            // awaits its provider; stop rather than consolidate without it.
            ownsLock: () =>
              alreadyOurs ? isAoiAutonomyLoopLockHeldByThisProcess(sessionsDir) : lock!.isOwner(),
            onCycle: (result) => {
              embed = result;
            },
            onConsolidation: (result) => {
              consolidation = result;
            },
          });
        } finally {
          lock?.release();
        }
        return true;
      });
      if (!ran) {
        writeJson(res, 409, {
          error:
            'Another process is maintaining this memory store right now. It runs on its own schedule; try again in a moment.',
          code: 'maintenance_lock_held',
        });
        return true;
      }
      const status = loadAoiMemoryEmbeddingStatus(sessionsDir, { configFile });
      // `settings` is included so the panel can refresh its coverage line from
      // this response; its parser requires that field and was discarding the
      // freshly computed status without it.
      writeJson(res, 200, { ok: true, embed, consolidation, settings, status });
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

    if (req.method === 'GET' && route === '/relationship') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // R2.1: the durable "us" record -- first meeting, session count, last
      // session summary, open threads, milestones. Display-only; absent means
      // no shared history yet, which callers must treat as "say nothing".
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        relationship: loadAoiRelationshipState(sessionsDir, sessionPath, Date.now()),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/relationship/retrospective') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // R4.2: the shared-history surface -- the latest "our week" narrative, the
      // ones before it, and the milestones behind them. Read-only; absent
      // records serve nulls rather than a manufactured story.
      const relationship = loadAoiRelationshipState(sessionsDir, sessionPath, Date.now());
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        retrospective: loadAoiWeeklyRetrospective(sessionsDir, sessionPath),
        history: loadAoiWeeklyRetrospectiveHistory(sessionsDir, sessionPath),
        milestones: relationship?.milestones ?? [],
        firstMetAt: relationship?.firstMetAt ?? null,
        sessionCount: relationship?.sessionCount ?? null,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/relationship/session-open') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // Creates the record on a first-ever open and increments the session
      // count only past the gap floor, so a browser refresh cannot inflate it.
      const now = Date.now();
      const relationship = recordAoiRelationshipSessionOpen(sessionsDir, sessionPath, now);
      // R3.3: derive milestones from real counters on every open. Derivation is
      // pure and the append is id-keyed, so this is idempotent; `added` is what
      // was actually crossed just now and therefore worth mentioning.
      // Read-only sourcing -- a store that cannot be read yields no milestone
      // rather than an assumed one.
      let autonomyLevel: string | null = null;
      let acceptedProposalCount: number | null = null;
      try {
        autonomyLevel = loadAoiAutonomyPolicy(sessionsDir, sessionPath)?.level ?? null;
      } catch {
        autonomyLevel = null;
      }
      try {
        acceptedProposalCount = loadAoiProposalDecisions(sessionsDir, sessionPath).filter(
          (decision) => decision.actor === 'user' && decision.action === 'accept',
        ).length;
      } catch {
        acceptedProposalCount = null;
      }
      const milestoneResult = applyAoiRelationshipMilestones(
        sessionsDir,
        sessionPath,
        deriveAoiRelationshipMilestones({
          sessionCount: relationship.sessionCount,
          autonomyLevel,
          acceptedProposalCount,
        }),
        now,
      );
      // R4.2: compose "our week" here rather than in the scheduler -- it is only
      // worth writing when the user is present to read it, and this keeps the
      // cadence off the tick's budget. Only a NEWLY created one is announced, so
      // the weekly mention happens once and rides the greeting (no new
      // interruption class).
      let newRetrospective = null;
      try {
        const result = maybeBuildAoiWeeklyRetrospective(sessionsDir, sessionPath, now);
        newRetrospective = result.created ? result.retrospective : null;
      } catch {
        newRetrospective = null;
      }
      // R6.2: derive and persist how Aoi is doing. EXPRESSION ONLY -- the mood is
      // stored on the relationship record and never handed to a gate. Derived
      // from the same read-only counters used above, so it costs one extra pass
      // over data already in hand.
      let mood = null;
      // The mood write is the LAST mutation of the record, so the response has to
      // carry its result -- returning the pre-mood snapshot would hand the client
      // a state whose `mood` is always undefined, which silently killed the mood
      // line in the persona bridge (R7.2).
      let relationshipForResponse = milestoneResult.state ?? relationship;
      try {
        // Habit momentum is optional context about the user's week. The day key
        // comes from the CLIENT because only the browser knows the user's local
        // calendar day -- this process may run in a different timezone, and
        // guessing would put check-ins in the wrong day. An absent or malformed
        // key means the input is skipped rather than estimated.
        let habitMomentum: AoiHabitMomentum | undefined;
        const todayKey = typeof body.todayKey === 'string' ? body.todayKey : '';
        if (isHabitDayKey(todayKey)) {
          try {
            habitMomentum =
              loadHabitMomentumForSession(sessionsDir, sessionPath, todayKey) ?? undefined;
          } catch {
            habitMomentum = undefined;
          }
        }
        const derived = deriveAoiMoodState({
          now,
          recentOutcomes: loadAoiOutcomeSignalRecords(sessionsDir, sessionPath, now).map(
            (record) => ({ result: record.result, createdAt: record.createdAt }),
          ),
          newMilestoneCount: milestoneResult.added.length,
          openThreadCount: relationshipForResponse.openThreads.length,
          ...(habitMomentum ? { habitMomentum } : {}),
        });
        const stored = recordAoiRelationshipMood(sessionsDir, sessionPath, derived, now);
        if (stored) {
          relationshipForResponse = stored;
        }
        mood = stored?.mood ?? derived;
      } catch {
        mood = null;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        relationship: relationshipForResponse,
        newMilestones: milestoneResult.added,
        newRetrospective,
        mood,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/relationship/session-summary') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // The store redacts + caps the summary and thread titles; request free
      // text never lands verbatim. No record yet -> nothing to update.
      const relationship = recordAoiRelationshipSessionSummary(sessionsDir, sessionPath, {
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        openThreads: Array.isArray(body.openThreads)
          ? body.openThreads
              .filter(
                (thread: unknown): thread is { title: string; noticedAt?: number } =>
                  typeof (thread as { title?: unknown })?.title === 'string',
              )
              .slice(0, 12)
          : undefined,
        now: Date.now(),
      });
      if (!relationship) {
        writeJson(res, 404, {
          error: 'No relationship record exists for this session yet.',
          code: 'relationship_absent',
        });
        return true;
      }
      writeJson(res, 200, { ok: true, sessionPath, relationship });
      return true;
    }

    if (req.method === 'POST' && route === '/relationship/arc-completed') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      // R7.1: an authored arc reached its end. Records the baseline plus an
      // arc_completed milestone so the relationship the arc built survives the
      // switch to free conversation. Idempotent per arc.
      const result = recordAoiRelationshipArcCompletion(sessionsDir, sessionPath, {
        arcId: typeof body.arcId === 'string' ? body.arcId : '',
        arcName: typeof body.arcName === 'string' ? body.arcName : '',
        completedStages: Array.isArray(body.completedStages)
          ? body.completedStages.filter(
              (stage: unknown): stage is string => typeof stage === 'string',
            )
          : [],
        now: Date.now(),
      });
      if (!result.state) {
        writeJson(res, 404, {
          error: 'No relationship record exists for this session yet.',
          code: 'relationship_absent',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        relationship: result.state,
        recorded: result.recorded,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/relationship/thread-asked') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const threadId = typeof body.threadId === 'string' ? body.threadId : '';
      if (!threadId) {
        writeJson(res, 400, {
          error: 'Missing threadId.',
          code: 'invalid_thread_id',
        });
        return true;
      }
      // Asked-once bookkeeping: without this a follow-up question would repeat
      // every session and read as nagging rather than remembering.
      const relationship = markAoiRelationshipThreadAsked(
        sessionsDir,
        sessionPath,
        threadId,
        Date.now(),
      );
      if (!relationship) {
        writeJson(res, 404, {
          error: 'No relationship record exists for this session yet.',
          code: 'relationship_absent',
        });
        return true;
      }
      writeJson(res, 200, { ok: true, sessionPath, relationship });
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

// A maintenance pass runs inside the loop's in-flight guard, so anything slower
// than this is delaying autonomy cycles and the operator should be able to see it.
const MAINTENANCE_SLOW_PASS_MS = 30_000;

// Stable identity for the config store a process is using. Two processes agree
// only when they resolve the SAME file; a dev server pointed at a throwaway
// OPENROOM_HOME must not display a daemon's unrelated settings as its own.
export function aoiCapabilityStoreId(configFile: string, sessionsDir: string): string {
  // Both paths, because they are configured independently: two processes can
  // share a config.json while writing different memory stores.
  return createHash('sha256')
    .update(`${resolve(configFile)} ${resolve(sessionsDir)}`)
    .digest('hex')
    .slice(0, 16);
}

// A request with no Origin is same-origin by definition (curl, a server-side
// caller, a same-origin fetch that omits it). One WITH an Origin must match the
// Host it was sent to; anything else is another site driving the operator's
// browser at this server.
export function isSameOriginRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    return true;
  }
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function logMaintenance(message: string): void {
  // ASCII-only operational logging.
  console.info(`[aoi-memory-maintenance] ${message}`);
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
  // The capability halves of this config (goal synthesis, idle confidence surge)
  // come from the operator's settings when a config file is present.
  const backgroundConfig = resolveAoiAutonomyBackgroundConfigFromEnv(
    env,
    resolve(options.configFile),
  );
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
  // role 'loop': authoritative. It may take over a maintenance sweep's lock (a
  // dev server holding it must not be able to keep the always-on loop from ever
  // starting), but never another loop's.
  const loopLock = acquireAoiAutonomyLoopLock(sessionsDir, { role: 'loop' });
  if (!loopLock) {
    return null;
  }
  // Store-wide memory maintenance, driven by the loop's own cycle.
  //
  // Holding the lock makes this process responsible for maintenance: the sweep in
  // any other process yields to it. The loop's per-session wakeup only embeds for
  // sessions that are enabled AND allowed network, so a daemon with no enabled
  // session would otherwise hold the lock and maintain nothing -- the store would
  // silently stop being embedded and consolidated.
  //
  // Bounds, settings and provider resolution are the standalone sweep's, with one
  // deliberate difference: the network ceiling. In THIS process a hard
  // AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK=0 is supposed to mean no autonomy egress
  // at all, and until now the only embedding path here was the wakeup's, which
  // honours it. Running the sweep here unchanged would have opened a second,
  // unceilinged path that POSTs memory text to a cloud embedder. So the embed half
  // is skipped under a hard-off ceiling -- unless the resolved provider is the
  // offline local embedder, which reaches no network and is therefore not what the
  // ceiling is about. Consolidation uses no provider and is never gated.
  //
  // Due-gated on the operator's configured interval rather than the loop's, and
  // seeded as if a pass had just run, so the first pass lands one interval after
  // start -- by which time any sweep this loop displaced has finished its cycle.
  let lastMaintenanceAt = Date.now();
  const runMaintenanceIfDue = async (): Promise<void> => {
    try {
      // Ownership is re-read, never assumed: if this loop lost the dir (an
      // operator deleting the lock, a reclaim race), it must stop writing.
      if (!loopLock.isOwner()) {
        return;
      }
      const settings = loadAoiMemoryMaintenanceSettings({ configFile, env });
      if (!settings.embedSweep.enabled && !settings.consolidation.enabled) {
        return;
      }
      const now = Date.now();
      if (now - lastMaintenanceAt < settings.embedSweep.intervalMs) {
        return;
      }
      lastMaintenanceAt = now;
      const provider = settings.embedSweep.enabled
        ? createServerAoiEmbeddingProvider({ configFile, env })
        : null;
      const providerReachesNetwork =
        provider !== null && provider.model !== AOI_LOCAL_EMBEDDING_MODEL;
      const embedBlockedByCeiling =
        providerReachesNetwork && backgroundConfig.allowNetworkCeiling === false;
      if (embedBlockedByCeiling) {
        logMaintenance('embed skipped: network is disabled for this deployment');
      }
      await runAoiMemoryMaintenanceCycle({
        sessionsDir,
        configFile,
        embedSweep: {
          enabled: settings.embedSweep.enabled && !embedBlockedByCeiling,
          max: settings.embedSweep.max,
        },
        consolidation: settings.consolidation,
        provider: embedBlockedByCeiling ? null : provider,
        ownsLock: loopLock.isOwner,
        onCycle: (result) => {
          if (result.embeddedCount > 0 || result.pendingCount > 0) {
            logMaintenance(
              `embedded ${result.embeddedCount}, ${result.pendingCount} still pending`,
            );
          }
        },
        onConsolidation: (result) => {
          if (result.supersededCount > 0) {
            logMaintenance(
              `consolidated ${result.clusterCount} clusters, ${result.supersededCount} superseded`,
            );
          }
        },
      });
      const elapsed = Date.now() - now;
      if (elapsed > MAINTENANCE_SLOW_PASS_MS) {
        // The pass runs inside the loop's in-flight guard, so a slow one delays
        // wakeups. Silence would look like a healthy idle loop.
        logMaintenance(`pass took ${elapsed}ms; autonomy cycles were held up that long`);
      }
    } catch (error) {
      // Best-effort: maintenance never breaks the autonomy loop. Still say so --
      // a permanently failing maintenance path must not be invisible.
      logMaintenance(`pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const runnerHandle = startAoiAutonomyBackgroundRunner({
    sessionsDir,
    configFile,
    workspaceRoot,
    afterCycle: runMaintenanceIfDue,
    intervalMs: backgroundConfig.intervalMs,
    runImmediately,
    allowNetworkCeiling: backgroundConfig.allowNetworkCeiling,
    maxSessionsPerCycle: backgroundConfig.maxSessionsPerCycle,
    maxCycleRuntimeMs: backgroundConfig.maxCycleRuntimeMs,
    maxBackgroundTickRuntimeMs: backgroundConfig.maxBackgroundTickRuntimeMs,
    llmDailyTokenBudget: backgroundConfig.llmDailyTokenBudget,
    goalSynthesisEnabled: backgroundConfig.goalSynthesisEnabled,
    // Re-read every cycle so flipping a capability in the UI takes effect on the
    // next tick. Without this the two flags are frozen at process start, and on
    // an always-on daemon switching one OFF would silently do nothing.
    resolveCapabilities: () => {
      const live = loadAoiAutonomyCapabilitySettings({ configFile, env });
      return { goalSynthesis: live.goalSynthesis, idleConfidenceSurge: live.idleConfidenceSurge };
    },
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
  // Only AFTER the in-flight cycle drains: releasing while one is still awaiting
  // would hand the dir to the next process mid-write.
  return {
    stop: async () => {
      try {
        await runnerHandle.stop();
      } finally {
        loopLock.release();
      }
    },
  };
}

// Start the loop-independent memory maintenance sweep (embed + consolidation) from
// env config. Returns null when NEITHER half is opted in (AOI_AUTONOMY_EMBED_SWEEP
// and AOI_AUTONOMY_CONSOLIDATION both unset). Shared by the Vite plugin and the
// standalone daemon so the wiring is never forked. It REUSES the single-instance
// loop lock -- the invariant being protected is "one process mutating the memory
// files", not "one loop" -- but takes it as role 'maintenance', which is
// subordinate: an autonomy loop starting later takes the lock over, and this sweep
// yields its cycles from that moment (its work is exactly what the loop's own tick
// does). The keeper re-checks per cycle, so maintenance also RESUMES if that loop
// later stops. Callers must not start this in a process that started the loop --
// one process does one or the other. Only touched after the enabled check -> OFF
// by default never writes the lock file.
export function startAoiMemoryEmbedSweepFromEnv(
  options: AoiAutonomyPluginOptions,
  env: Record<string, string | undefined> = process.env,
): AoiMemoryEmbedSweepHandle | null {
  const sessionsDir = resolve(options.sessionsDir);
  const configFile = resolve(options.configFile);
  // The settings UI (config.json: aoiMemoryMaintenance) decides these; the env
  // vars remain the fallback for headless deployments. Still OFF by default, so
  // the loop lock is untouched until one half is actually opted in.
  const settings = loadAoiMemoryMaintenanceSettings({ configFile, env });
  if (!settings.embedSweep.enabled && !settings.consolidation.enabled) {
    return null;
  }
  const lockKeeper = createAoiAutonomyLoopLockKeeper(sessionsDir, { role: 'maintenance' });
  // Claim the dir now rather than at the first tick, so ownership is observable
  // from the moment the sweep starts (and logged once either way). A loop already
  // owning it simply means the early cycles yield; the keeper retries every tick.
  lockKeeper.ownsLock();
  const sweepHandle = startAoiMemoryEmbedSweep({
    ownsLock: lockKeeper.ownsLock,
    sessionsDir,
    configFile,
    intervalMs: settings.embedSweep.intervalMs,
    max: settings.embedSweep.max,
    embedEnabled: settings.embedSweep.enabled,
    consolidation: {
      enabled: settings.consolidation.enabled,
      max: settings.consolidation.max,
    },
    // Re-read every cycle so flipping a toggle in the UI takes effect on the
    // next tick; only the interval itself still needs a restart.
    resolveCycleSettings: () => {
      const live = loadAoiMemoryMaintenanceSettings({ configFile, env });
      return { embedSweep: live.embedSweep, consolidation: live.consolidation };
    },
  });
  return {
    stop: async () => {
      // Drain first: an in-flight cycle is still writing memory files, and the
      // lock is what keeps the next process out of them.
      try {
        await sweepHandle.stop();
      } finally {
        lockKeeper.release();
      }
    },
  };
}

export function aoiAutonomyPlugin(options: AoiAutonomyPluginOptions): Plugin {
  const middleware = createAoiAutonomyMiddleware(options);

  // Background autonomy loop + the loop-independent memory maintenance sweep are
  // started once and stopped on server close. Both are OFF unless opted in (each
  // *FromEnv returns null otherwise). A process runs ONE of them, never both: when
  // this process started the loop, its tick already covers embedding and
  // consolidation, so the sweep would only be dead weight competing for the same
  // lock. The sweep is for hosts with no loop of their own -- typically a dev
  // server alongside the standalone daemon.
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
    sweepHandle = backgroundHandle ? null : startAoiMemoryEmbedSweepFromEnv(options);
    if (!backgroundHandle && !sweepHandle) {
      return;
    }
    lifecycleBound = true;
    httpServer?.on?.('close', () => {
      // Vite's close hook is sync, so the drain (and the lock release that
      // follows it) completes on its own; nothing here may block the server.
      void backgroundHandle?.stop();
      backgroundHandle = null;
      void sweepHandle?.stop();
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
