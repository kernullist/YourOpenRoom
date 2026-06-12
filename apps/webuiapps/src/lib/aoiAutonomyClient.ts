import type {
  AoiAutonomyPolicy,
  AoiAutonomyStatus,
  AoiAutonomyTickReason,
  AoiAutonomyTickResult,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiGoal,
  AoiGoalProgressEvent,
  AoiMissionDecisionAction,
  AoiMissionState,
  AoiObservation,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiProposalFeedbackCategory,
  AoiReflection,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiAutonomyEvaluationResult } from './aoiAutonomyEvaluation';

const API_PREFIX = '/api/aoi-autonomy';

export interface AoiAutonomyProposalList {
  sessionPath: string;
  active: AoiProposal[];
  archived: AoiProposal[];
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

export interface AoiAutonomyDashboardSnapshot {
  sessionPath: string;
  status: AoiAutonomyStatus;
  proposals: AoiAutonomyProposalList;
  goals: AoiAutonomyGoalList;
  mission: AoiMissionState | null;
  environmentSources: AoiEnvironmentSourceRegistry;
  workspaceSnapshot: AoiWorkspaceSnapshot | null;
  evaluation: AoiAutonomyEvaluationResult;
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

export interface AoiWorkspaceSignalResponse {
  ok: boolean;
  sessionPath: string;
  snapshot: AoiWorkspaceSnapshot | null;
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
  result?: Record<string, unknown>;
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
    mission: isRecord(payload.mission) ? (payload.mission as AoiMissionState) : null,
    status: isRecord(payload.status) ? (payload.status as AoiAutonomyStatus) : undefined,
  };
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
    snapshot: isRecord(payload.snapshot) ? (payload.snapshot as AoiWorkspaceSnapshot) : null,
  };
}

export async function fetchAoiAutonomyDashboard(
  sessionPath: string,
): Promise<AoiAutonomyDashboardSnapshot> {
  const [status, proposals, goals, mission, environmentSources, workspace, evaluation] =
    await Promise.all([
      fetchAoiAutonomyStatus(sessionPath),
      fetchAoiAutonomyProposals(sessionPath, true),
      fetchAoiAutonomyGoals(sessionPath),
      fetchAoiMissionState(sessionPath),
      fetchAoiEnvironmentSources(sessionPath),
      fetchAoiWorkspaceSnapshot(sessionPath),
      fetchAoiAutonomyEvaluation(sessionPath),
    ]);

  return {
    sessionPath,
    status,
    proposals,
    goals,
    mission: mission.mission,
    environmentSources: environmentSources.registry,
    workspaceSnapshot: workspace.snapshot,
    evaluation: evaluation.evaluation,
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
      patch: input.patch,
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
    status: isRecord(payload.status) ? (payload.status as AoiAutonomyStatus) : undefined,
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
    goal: isRecord(payload.goal) ? (payload.goal as AoiGoal) : null,
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
      ? (payload.evaluation as AoiAutonomyEvaluationResult)
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
    goal: isRecord(payload.goal) ? (payload.goal as AoiGoal) : null,
    active: asArray<AoiGoal>(payload.active),
    archived: asArray<AoiGoal>(payload.archived),
    proposal: isRecord(payload.proposal) ? (payload.proposal as AoiProposal) : undefined,
    decision: isRecord(payload.decision) ? (payload.decision as AoiProposalDecision) : undefined,
    status: isRecord(payload.status) ? (payload.status as AoiAutonomyStatus) : undefined,
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
    mission: isRecord(payload.mission) ? (payload.mission as AoiMissionState) : null,
    status: isRecord(payload.status) ? (payload.status as AoiAutonomyStatus) : undefined,
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
