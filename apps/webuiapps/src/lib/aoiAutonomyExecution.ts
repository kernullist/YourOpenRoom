import {
  evaluateAoiProposalExecution,
  FRESH_ACCEPTANCE_MS,
  getAoiApprovedConnectorCallPolicyForProposal,
} from './aoiAutonomyPolicy';
import {
  applyAoiProposalExecutionTransition,
  buildAoiAutonomyStatus,
  appendAoiCommandAuditRecord,
  appendAoiFileMutationAuditRecord,
  appendAoiAppActionAuditRecord,
  appendAoiAppOperationDispatch,
  appendAoiConnectorCallAuditRecord,
  loadAoiActiveProposals,
  loadAoiAutonomyPolicy,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import { ingestAoiObservation } from './aoiAutonomyObserver';
import {
  readAoiResearchRunArtifact,
  readAoiResearchRunStatus,
  startAoiResearchRunFromServer,
  toAoiResearchRunSummary,
  type AoiResearchServerArtifactResult,
  type AoiResearchServerStartResult,
} from './aoiResearchPlugin';
import {
  recordAoiKiraHandoffRelations,
  recordAoiProcedurePromotionRelations,
  recordAoiResearchFollowupExecutionRelations,
} from './aoiAutonomyRelations';
import { saveServerAoiMemoryCandidates, saveServerAoiMemoryEpisode } from './aoiMemoryServerWriter';
import { sanitizeAoiProcedureContent, type AoiMemoryEntry } from './aoiMemoryShared';
import {
  buildAoiKiraHandoffPreview,
  getAoiKiraSafeNarrowingSuggestion,
  type AoiKiraHandoffCreateResult,
  type AoiKiraHandoffPreview,
} from './aoiKiraHandoff';
import { buildAoiPreparedActionPlan } from './aoiSafeActionPlan';
import {
  buildAoiBoundedWorkOrderFromProposal,
  type AoiBoundedWorkOrder,
} from './aoiBoundedWorkOrder';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
  normalizeAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import { runAoiApprovedCommand } from './aoiApprovedCommandRunner';
import {
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
  normalizeAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import { applyAoiApprovedFileMutation } from './aoiApprovedFileMutationRunner';
import {
  createAoiApprovedAppActionRequest,
  evaluateAoiApprovedAppActionPolicy,
  normalizeAoiApprovedAppActionPolicy,
} from './aoiApprovedAppActionPolicy';
import { applyAoiApprovedAppAction } from './aoiApprovedAppActionRunner';
import {
  buildAoiAppOperationDispatch,
  isAoiAppOpLiveDispatchEnabled,
} from './aoiAppOperationDispatch';
import {
  isAoiApprovalTtlEnabled,
  resolveAoiApprovalTtlWindowMs,
  wasAoiApprovalTtlWindowUsed,
} from './aoiApprovalTtl';
import { buildAoiAutonomyLevelPromotionScorecard } from './aoiAutonomyLevelPromotionRunner';
import { isAoiTrustedOperatorReadiness } from './aoiAutonomyLevelPromotion';
import type { AoiJarvisReadinessScorecard } from './aoiJarvisReadinessScorecard';
import {
  createAoiApprovedConnectorCallRequest,
  evaluateAoiApprovedConnectorCallPolicy,
  normalizeAoiApprovedConnectorCallPolicy,
} from './aoiApprovedConnectorCallPolicy';
import { applyAoiApprovedConnectorCall } from './aoiApprovedConnectorCallRunner';
import type { AoiMcpConnectorsConfig } from './aoiMcpConnectorRegistry';
import {
  isAoiSideEffectingLiveRpcEnabled,
  loadAoiMcpConnectorsFromConfigFile,
} from './aoiMcpConnectorsConfigFile';
import { recordAoiValidationSignal } from './aoiWorkspaceSignals';
import { createSupervisedKiraWorkItem } from './kiraAutomationPlugin';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import {
  recordAoiOperatorTimelineEvent,
  recordAoiProposalDecisionTimelineEvent,
} from './aoiOperatorTimeline';
import type {
  AoiAutonomyStatus,
  AoiApprovedCommandPolicy,
  AoiApprovedCommandRequest,
  AoiApprovedCommandResult,
  AoiApprovedFileMutationPolicy,
  AoiApprovedFileMutationRequest,
  AoiApprovedFileMutationResult,
  AoiApprovedAppActionPolicy,
  AoiApprovedAppActionRequest,
  AoiApprovedAppActionResult,
  AoiAppOperationDispatch,
  AoiApprovedConnectorCallPolicy,
  AoiApprovedConnectorCallRequest,
  AoiApprovedConnectorCallResult,
  AoiPreparedActionPlan,
  AoiProposal,
  AoiProposalDecision,
} from './aoiAutonomyTypes';
import type { AoiResearchArtifactName, AoiResearchManifest } from './aoiResearchTypes';

const MAX_EXECUTION_TEXT_CHARS = 4000;

function recordAoiExecutionTimelineBestEffort(record: () => void): void {
  try {
    record();
  } catch (error) {
    console.warn('[AoiAutonomyExecution] Failed to record Aoi timeline event', error);
  }
}

export interface AoiProposalExecutionDependencies {
  readResearchStatus?: (
    sessionsDir: string,
    sessionPath: string,
    runId: string,
  ) => AoiResearchManifest;
  readResearchArtifact?: (
    sessionsDir: string,
    sessionPath: string,
    runId: string,
    artifact: AoiResearchArtifactName,
  ) => AoiResearchServerArtifactResult;
  startResearch?: (params: {
    sessionsDir: string;
    configFile: string;
    serverOrigin: string;
    request: {
      sessionPath: string;
      request: string;
      mode: 'quick' | 'standard' | 'deep';
      language?: 'match-user' | 'ko' | 'en';
      recency?: 'any' | 'day' | 'week' | 'month' | 'year';
      maxSources?: number;
    };
    allowDuplicate?: boolean;
  }) => Promise<AoiResearchServerStartResult>;
  createKiraWork?: (params: {
    sessionsDir: string;
    sessionPath: string;
    proposal: AoiProposal;
    preview: AoiKiraHandoffPreview;
    now: number;
  }) => AoiKiraHandoffCreateResult;
  runApprovedCommand?: (params: {
    request: AoiApprovedCommandRequest;
    approvedPolicy?: AoiApprovedCommandPolicy;
    workspaceRoot: string;
    now: number;
  }) => Promise<AoiApprovedCommandResult>;
  runApprovedConnectorCall?: (params: {
    request: AoiApprovedConnectorCallRequest;
    approvedPolicy?: AoiApprovedConnectorCallPolicy;
    connectors: AoiMcpConnectorsConfig | null;
    now: number;
  }) => Promise<AoiApprovedConnectorCallResult>;
  // P2/B3-2 + B3-3: the field-evidence readiness scorecard that gates the trust-bounded
  // approval TTL (app_operation) AND the side-effecting connector trust check. Defaults to
  // buildAoiAutonomyLevelPromotionScorecard (the same non-self-authorable signal B2 uses);
  // injectable so the trust gates can be exercised in tests.
  readReadinessScorecard?: (
    sessionsDir: string,
    sessionPath: string,
    now: number,
  ) => AoiJarvisReadinessScorecard;
}

export interface AoiProposalExecutionResult {
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

export interface AoiProposalPreviewResult {
  ok: boolean;
  sessionPath: string;
  proposal: AoiProposal;
  status: AoiAutonomyStatus;
  previewed: boolean;
  outcome: 'previewed' | 'blocked';
  reasons: string[];
  preparedActionPlan?: AoiPreparedActionPlan;
  approvedCommandPolicy?: AoiApprovedCommandPolicy;
  boundedWorkOrder?: AoiBoundedWorkOrder;
  result?: Record<string, unknown>;
}

function getStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getRunId(params: Record<string, unknown>): string {
  return getStringParam(params, 'runId') || getStringParam(params, 'run_id');
}

function getArtifact(params: Record<string, unknown>): AoiResearchArtifactName | null {
  const artifact = getStringParam(params, 'artifact') || 'report';
  if (
    artifact === 'manifest' ||
    artifact === 'report' ||
    artifact === 'sources' ||
    artifact === 'evidence'
  ) {
    return artifact;
  }
  return null;
}

function compactContent(value: unknown): {
  contentPreview: string;
  contentLength: number;
  truncated: boolean;
} {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const content = raw || '';
  if (content.length <= MAX_EXECUTION_TEXT_CHARS) {
    return {
      contentPreview: content,
      contentLength: content.length,
      truncated: false,
    };
  }
  return {
    contentPreview: `${content.slice(0, MAX_EXECUTION_TEXT_CHARS - 3).trimEnd()}...`,
    contentLength: content.length,
    truncated: true,
  };
}

function normalizeStartMode(value: unknown): 'quick' | 'standard' | 'deep' | null {
  if (value === 'quick' || value === 'standard' || value === 'deep') {
    return value;
  }
  return null;
}

function normalizeLanguage(value: unknown): 'match-user' | 'ko' | 'en' | undefined {
  if (value === 'match-user' || value === 'ko' || value === 'en') {
    return value;
  }
  return undefined;
}

function normalizeRecency(value: unknown): 'any' | 'day' | 'week' | 'month' | 'year' | undefined {
  if (
    value === 'any' ||
    value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'year'
  ) {
    return value;
  }
  return undefined;
}

function normalizeMaxSources(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(40, Math.max(1, Math.trunc(parsed)));
}

function sanitizeEpisodeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'procedure';
}

function normalizePromotionTarget(value: unknown): 'memory' | 'skill' {
  return value === 'skill' ? 'skill' : 'memory';
}

function normalizeStringListParam(...values: unknown[]): string[] {
  const terms: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) {
        continue;
      }
      terms.push(item.trim().slice(0, 48));
      if (terms.length >= 12) {
        return [...new Set(terms)];
      }
    }
  }
  return [...new Set(terms)];
}

function buildApprovedCommandRequestFromProposal(params: {
  proposal: AoiProposal;
  sessionPath: string;
  decisionId?: string;
  now: number;
}): AoiApprovedCommandRequest {
  const actionParams = params.proposal.acceptAction?.params ?? {};
  return createAoiApprovedCommandRequest({
    sessionPath: params.sessionPath,
    proposalId: params.proposal.id,
    decisionId: params.decisionId,
    command: actionParams.command,
    cwd: actionParams.cwd ?? actionParams.directory,
    purpose: actionParams.purpose ?? params.proposal.title,
    risk: params.proposal.risk,
    timeoutMs: actionParams.timeoutMs ?? actionParams.timeout_ms,
    requestedAt: params.now,
    evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
  });
}

function buildApprovedFileMutationRequestFromProposal(params: {
  proposal: AoiProposal;
  sessionPath: string;
  decisionId?: string;
  now: number;
}): AoiApprovedFileMutationRequest {
  const actionParams = params.proposal.acceptAction?.params ?? {};
  return createAoiApprovedFileMutationRequest({
    sessionPath: params.sessionPath,
    proposalId: params.proposal.id,
    decisionId: params.decisionId,
    operation:
      params.proposal.acceptAction?.kind === 'file_patch'
        ? 'patch'
        : params.proposal.acceptAction?.kind === 'file_delete'
          ? 'delete'
          : 'write',
    path: actionParams.path,
    content: actionParams.content,
    patchOps: actionParams.patchOps ?? actionParams.patch_ops,
    purpose: actionParams.purpose ?? params.proposal.title,
    risk: params.proposal.risk,
    requestedAt: params.now,
    evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
  });
}

function buildApprovedAppActionRequestFromProposal(params: {
  proposal: AoiProposal;
  sessionPath: string;
  decisionId?: string;
  now: number;
}): AoiApprovedAppActionRequest {
  const actionParams = params.proposal.acceptAction?.params ?? {};
  return createAoiApprovedAppActionRequest({
    sessionPath: params.sessionPath,
    proposalId: params.proposal.id,
    decisionId: params.decisionId,
    appReference: actionParams.appReference ?? actionParams.appName ?? actionParams.app,
    capabilityId: actionParams.capabilityId,
    intentReference: actionParams.intentReference ?? actionParams.intent,
    actionType: actionParams.actionType ?? actionParams.action,
    requestedOperation: actionParams.requestedOperation ?? actionParams.operation,
    operationParams: actionParams.operationParams ?? actionParams.actionParams,
    path: actionParams.path,
    content: actionParams.content,
    patchOps: actionParams.patchOps ?? actionParams.patch_ops,
    purpose: actionParams.purpose ?? params.proposal.title,
    risk: params.proposal.risk,
    requestedAt: params.now,
    evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
  });
}

// P2/B3-1: when live dispatch is opted in, an approved app_operation is QUEUED for
// client-mediated dispatch over the agent->app bus instead of a Kira review handoff.
// Returns the queued record, or null to fall back to the Kira handoff (gate OFF, the
// routing is not a pure app_operation, the app id / action type is missing, or the
// append fails). OFF by default; the record carries the content-addressed approval
// fingerprint so the client bridge re-checks it before dispatching, and the L5 +
// approval gate already governed this exact operation.
function maybeQueueAppOperationDispatch(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  decisionId: string;
  policy?: AoiApprovedAppActionPolicy;
  appActionResult: AoiApprovedAppActionResult;
  now: number;
}): AoiAppOperationDispatch | null {
  if (!isAoiAppOpLiveDispatchEnabled()) {
    return null;
  }
  // Only a pure app_operation is eligible -- file_backed routing already mutated on
  // disk and never reaches the review-handoff branch as a live op.
  if (params.appActionResult.routing !== 'app_operation') {
    return null;
  }
  const policy = params.policy;
  if (!policy || typeof policy.appId !== 'number') {
    return null;
  }
  const request = buildApprovedAppActionRequestFromProposal({
    proposal: params.proposal,
    sessionPath: params.sessionPath,
    decisionId: params.decisionId,
    now: params.now,
  });
  const actionType = (request.actionType ?? '').trim();
  if (!actionType) {
    // No concrete action type to publish over the agent->app bus; fall back to the
    // Kira handoff so the approved operation is never silently dropped.
    return null;
  }
  try {
    const dispatch = buildAoiAppOperationDispatch({
      sessionPath: params.sessionPath,
      appId: policy.appId,
      appName: policy.appName,
      actionType,
      params: request.operationParams ?? {},
      approvalFingerprint: policy.approvalFingerprint,
      proposalId: params.proposal.id,
      decisionId: params.decisionId,
      evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
      now: params.now,
    });
    return appendAoiAppOperationDispatch(params.sessionsDir, params.sessionPath, dispatch);
  } catch (error) {
    console.warn('[AoiAutonomyExecution] Failed to queue app-operation live dispatch', error);
    return null;
  }
}

function buildApprovedConnectorCallRequestFromProposal(params: {
  proposal: AoiProposal;
  sessionPath: string;
  decisionId?: string;
  now: number;
}): AoiApprovedConnectorCallRequest {
  const actionParams = params.proposal.acceptAction?.params ?? {};
  return createAoiApprovedConnectorCallRequest({
    sessionPath: params.sessionPath,
    proposalId: params.proposal.id,
    decisionId: params.decisionId,
    connectorRef: actionParams.connectorRef ?? actionParams.connectorId ?? actionParams.connector,
    toolName: actionParams.toolName ?? actionParams.tool,
    resourceUri: actionParams.resourceUri ?? actionParams.resource_uri ?? actionParams.uri,
    args: actionParams.args ?? actionParams.arguments ?? actionParams.toolArgs,
    purpose: actionParams.purpose ?? params.proposal.title,
    risk: params.proposal.risk,
    requestedAt: params.now,
    evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
    // Explicit irreversibility acknowledgment from the approved action params
    // (string-valued); only meaningful for a side-effecting call behind the env gate.
    acknowledgeIrreversible: actionParams.acknowledgeIrreversible === 'true',
  });
}

function summarizePromotedMemory(memory: AoiMemoryEntry): Record<string, unknown> {
  return {
    id: memory.id,
    type: memory.type,
    status: memory.status,
    content: memory.content,
    confidence: memory.confidence,
    tags: memory.tags,
  };
}

function createDefaultKiraWorkFromPreview(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  preview: AoiKiraHandoffPreview;
  now: number;
}): AoiKiraHandoffCreateResult {
  const created = createSupervisedKiraWorkItem({
    sessionsDir: params.sessionsDir,
    input: {
      sessionPath: params.sessionPath,
      projectName: params.preview.projectName,
      title: params.preview.title,
      objective: params.preview.objective,
      scope: params.preview.scope,
      likelyFilesOrModules: params.preview.likelyFilesOrModules,
      nonGoals: params.preview.nonGoals,
      validationCommands: params.preview.validationCommands,
      riskLevel: params.preview.riskLevel,
      rollbackExpectations: params.preview.rollbackExpectations,
      reviewExpectations: params.preview.reviewExpectations,
      evidenceRefs: params.preview.evidenceRefs,
      constraints: params.preview.constraints,
      sourceProposalId: params.proposal.id,
      now: params.now,
    },
  });
  return {
    kind: 'create_kira_work',
    preview: params.preview,
    work: {
      id: created.work.id,
      ref: created.workRef,
      title: created.work.title,
      projectName: created.work.projectName,
      status: created.work.status,
    },
    reviewRequired: true,
    route: '/kira',
    openPayload: {
      workId: created.work.id,
      focusType: 'work',
    },
  };
}

function isAoiApprovedCommandResult(value: unknown): value is AoiApprovedCommandResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<AoiApprovedCommandResult>;
  return (
    result.version === 1 &&
    typeof result.ok === 'boolean' &&
    typeof result.command === 'string' &&
    typeof result.cwdLabel === 'string' &&
    (typeof result.exitCode === 'number' || result.exitCode === null) &&
    typeof result.timedOut === 'boolean' &&
    typeof result.durationMs === 'number' &&
    typeof result.stdoutExcerpt === 'string' &&
    typeof result.stderrExcerpt === 'string' &&
    typeof result.stdoutTruncated === 'boolean' &&
    typeof result.stderrTruncated === 'boolean' &&
    Boolean(result.auditRecord) &&
    Array.isArray(result.evidenceRefs)
  );
}

function isAoiApprovedFileMutationResult(value: unknown): value is AoiApprovedFileMutationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<AoiApprovedFileMutationResult>;
  return (
    result.version === 1 &&
    typeof result.ok === 'boolean' &&
    (result.operation === 'write' ||
      result.operation === 'patch' ||
      result.operation === 'delete') &&
    typeof result.pathLabel === 'string' &&
    typeof result.applied === 'boolean' &&
    typeof result.rolledBack === 'boolean' &&
    Boolean(result.auditRecord) &&
    Array.isArray(result.evidenceRefs)
  );
}

function isAoiApprovedAppActionResult(value: unknown): value is AoiApprovedAppActionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<AoiApprovedAppActionResult>;
  return (
    result.version === 1 &&
    typeof result.ok === 'boolean' &&
    typeof result.appName === 'string' &&
    typeof result.capabilityId === 'string' &&
    (result.routing === 'file_backed' || result.routing === 'app_operation') &&
    typeof result.applied === 'boolean' &&
    typeof result.rolledBack === 'boolean' &&
    Boolean(result.auditRecord) &&
    Array.isArray(result.evidenceRefs)
  );
}

function isAoiApprovedConnectorCallResult(value: unknown): value is AoiApprovedConnectorCallResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<AoiApprovedConnectorCallResult>;
  return (
    result.version === 1 &&
    typeof result.ok === 'boolean' &&
    typeof result.connectorId === 'string' &&
    typeof result.toolName === 'string' &&
    (result.routing === 'live_read_only' ||
      result.routing === 'side_effecting' ||
      result.routing === 'unknown') &&
    typeof result.applied === 'boolean' &&
    Boolean(result.auditRecord) &&
    Array.isArray(result.evidenceRefs)
  );
}

function normalizeValidationScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.replace(/\\/g, '/').trim().slice(0, 160)),
    ),
  ].slice(0, 12);
}

function inferCommandValidationScopes(
  proposal: AoiProposal,
  result: Record<string, unknown>,
): string[] {
  const actionParams = proposal.acceptAction?.params ?? {};
  const explicit = normalizeValidationScopes(
    actionParams.touchedFileScopes ?? actionParams.touched_file_scopes,
  );
  if (explicit.length > 0) {
    return explicit;
  }
  const policy = result.policy as { program?: unknown; args?: unknown } | undefined;
  const args = Array.isArray(policy?.args)
    ? policy.args.filter((item): item is string => typeof item === 'string')
    : [];
  if (policy?.program === 'pnpm') {
    const separatorIndex = args.indexOf('--');
    if (separatorIndex >= 0) {
      return args.slice(separatorIndex + 1).map((item) => item.replace(/\\/g, '/'));
    }
    return ['apps/webuiapps/src'];
  }
  return ['*'];
}

function blockProposal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
  reason: string;
  now?: number;
  outcome?: 'blocked' | 'failed';
  result?: Record<string, unknown>;
}): AoiProposalExecutionResult {
  const transition = applyAoiProposalExecutionTransition(params.sessionsDir, params.sessionPath, {
    proposalId: params.proposalId,
    nextStatus: 'blocked',
    actor: 'system',
    reason: params.reason,
    now: params.now,
  });
  recordAoiExecutionTimelineBestEffort(() => {
    recordAoiProposalDecisionTimelineEvent({
      sessionsDir: params.sessionsDir,
      proposal: transition.proposal,
      decision: transition.decision,
    });
  });
  return {
    ok: true,
    sessionPath: params.sessionPath,
    proposal: transition.proposal,
    decision: transition.decision,
    status: buildAoiAutonomyStatus(params.sessionsDir, params.sessionPath, params.now),
    executed: false,
    outcome: params.outcome ?? 'blocked',
    reasons: [params.reason],
    ...(params.result ? { result: params.result } : {}),
  };
}

async function executeAllowedProposalAction(params: {
  sessionsDir: string;
  configFile: string;
  serverOrigin: string;
  workspaceRoot: string;
  sessionPath: string;
  proposal: AoiProposal;
  decisionId?: string;
  approvedCommandPolicy?: AoiApprovedCommandPolicy;
  approvedFileMutationPolicy?: AoiApprovedFileMutationPolicy;
  approvedAppActionPolicy?: AoiApprovedAppActionPolicy;
  approvedConnectorCallPolicy?: AoiApprovedConnectorCallPolicy;
  connectors?: AoiMcpConnectorsConfig | null;
  dependencies: AoiProposalExecutionDependencies;
  now: number;
}): Promise<Record<string, unknown>> {
  const action = params.proposal.acceptAction;
  if (!action) {
    throw new Error('Proposal has no accept action.');
  }

  const actionParams = action.params ?? {};
  if (action.kind === 'get_research_status') {
    const runId = getRunId(actionParams);
    if (!runId) {
      throw new Error('runId is required for get_research_status.');
    }
    const run = (params.dependencies.readResearchStatus ?? readAoiResearchRunStatus)(
      params.sessionsDir,
      params.sessionPath,
      runId,
    );
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(run),
    };
  }

  if (action.kind === 'open_research_artifact') {
    const runId = getRunId(actionParams);
    const artifact = getArtifact(actionParams);
    if (!runId || !artifact) {
      throw new Error('runId and artifact are required for open_research_artifact.');
    }
    const run = (params.dependencies.readResearchStatus ?? readAoiResearchRunStatus)(
      params.sessionsDir,
      params.sessionPath,
      runId,
    );
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(run),
      artifact,
      route: '/aoi-research',
      openPayload: {
        runId,
        artifact,
      },
    };
  }

  if (action.kind === 'read_research_artifact') {
    const runId = getRunId(actionParams);
    const artifact = getArtifact(actionParams);
    if (!runId || !artifact) {
      throw new Error('runId and artifact are required for read_research_artifact.');
    }
    const artifactResult = (params.dependencies.readResearchArtifact ?? readAoiResearchRunArtifact)(
      params.sessionsDir,
      params.sessionPath,
      runId,
      artifact,
    );
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(artifactResult.run),
      artifact,
      contentType: artifactResult.contentType,
      ...compactContent(artifactResult.content),
    };
  }

  if (action.kind === 'start_research') {
    const request = getStringParam(actionParams, 'request');
    const mode = normalizeStartMode(actionParams.mode);
    const requestedSessionPath = normalizeAoiAutonomySessionPath(actionParams.sessionPath);
    if (!request || !mode || requestedSessionPath !== params.sessionPath) {
      throw new Error('request, mode, and matching sessionPath are required for start_research.');
    }
    const startResult = await (params.dependencies.startResearch ?? startAoiResearchRunFromServer)({
      sessionsDir: params.sessionsDir,
      configFile: params.configFile,
      serverOrigin: params.serverOrigin,
      request: {
        sessionPath: params.sessionPath,
        request,
        mode,
        language: normalizeLanguage(actionParams.language),
        recency: normalizeRecency(actionParams.recency),
        maxSources: normalizeMaxSources(actionParams.maxSources ?? actionParams.max_sources),
      },
      allowDuplicate: actionParams.allowDuplicate === true || actionParams.allow_duplicate === true,
    });
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(startResult.run),
      background: startResult.background,
      maxConcurrentRuns: startResult.maxConcurrentRuns,
    };
  }

  if (action.kind === 'save_memory') {
    if (actionParams.type !== 'procedure') {
      throw new Error('Only procedure memory promotion is supported for save_memory proposals.');
    }
    const content = sanitizeAoiProcedureContent(getStringParam(actionParams, 'content'));
    if (content.length < 8) {
      throw new Error('Procedure content was empty after safety filtering.');
    }
    const target = normalizePromotionTarget(actionParams.target);
    const name = getStringParam(actionParams, 'name') || params.proposal.title;
    const description =
      getStringParam(actionParams, 'description') ||
      'User-approved Aoi procedure candidate promoted from an autonomy proposal.';
    const triggerTerms = normalizeStringListParam(
      actionParams.triggerTerms,
      actionParams.trigger_terms,
    );

    if (target === 'skill') {
      return {
        kind: action.kind,
        target,
        skillDraft: {
          name,
          description,
          triggerTerms,
          body: content,
          enabled: true,
          trusted: false,
        },
      };
    }

    const episode = saveServerAoiMemoryEpisode(params.sessionsDir, params.sessionPath, {
      id: `aoi_procedure_${sanitizeEpisodeIdPart(params.proposal.id)}`,
      source: 'manual_memory',
      userMessage: content,
      assistantMessage: params.proposal.title,
      toolCalls: ['save_memory'],
      outcome: 'procedure_promoted',
    });
    const memories = saveServerAoiMemoryCandidates(
      params.sessionsDir,
      params.sessionPath,
      [
        {
          scope: 'agent',
          type: 'procedure',
          content,
          importance: 0.82,
          confidence: 0.78,
          tags: ['procedure', 'aoi-autonomy', 'approved'],
          entities: [name, ...triggerTerms],
        },
      ],
      episode.id,
    );
    const promoted = memories.filter(
      (memory) => memory.type === 'procedure' && memory.sourceEpisodeIds.includes(episode.id),
    );
    return {
      kind: action.kind,
      target,
      episodeId: episode.id,
      memories: promoted.map(summarizePromotedMemory),
    };
  }

  if (action.kind === 'create_kira_work') {
    const preview = buildAoiKiraHandoffPreview(params.proposal, { now: params.now });
    const createKiraWork = params.dependencies.createKiraWork ?? createDefaultKiraWorkFromPreview;
    return createKiraWork({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      proposal: params.proposal,
      preview,
      now: params.now,
    }) as unknown as Record<string, unknown>;
  }

  if (action.kind === 'run_command') {
    const request = buildApprovedCommandRequestFromProposal({
      proposal: params.proposal,
      sessionPath: params.sessionPath,
      decisionId: params.decisionId,
      now: params.now,
    });
    const policy = evaluateAoiApprovedCommandPolicy(request);
    if (!policy.allowed) {
      throw new Error(`approved_command_blocked:${policy.blockReasons.join(',')}`);
    }
    const result = await (
      params.dependencies.runApprovedCommand ??
      ((runnerParams: {
        request: AoiApprovedCommandRequest;
        approvedPolicy?: AoiApprovedCommandPolicy;
        workspaceRoot: string;
        now: number;
      }) =>
        runAoiApprovedCommand(runnerParams.request, {
          ...(runnerParams.approvedPolicy ? { approvedPolicy: runnerParams.approvedPolicy } : {}),
          workspaceRoot: runnerParams.workspaceRoot,
          now: runnerParams.now,
        }))
    )({
      request,
      ...(params.approvedCommandPolicy ? { approvedPolicy: params.approvedCommandPolicy } : {}),
      workspaceRoot: params.workspaceRoot,
      now: params.now,
    });
    return {
      kind: action.kind,
      policy,
      commandResult: result,
      auditRecord: result.auditRecord,
    } as unknown as Record<string, unknown>;
  }

  if (
    action.kind === 'file_write' ||
    action.kind === 'file_patch' ||
    action.kind === 'file_delete'
  ) {
    const request = buildApprovedFileMutationRequestFromProposal({
      proposal: params.proposal,
      sessionPath: params.sessionPath,
      decisionId: params.decisionId,
      now: params.now,
    });
    const policy = evaluateAoiApprovedFileMutationPolicy(request);
    if (!policy.allowed) {
      throw new Error(`file_mutation_blocked:${policy.blockReasons.join(',')}`);
    }
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: params.workspaceRoot,
      ...(params.approvedFileMutationPolicy
        ? { approvedPolicy: params.approvedFileMutationPolicy }
        : {}),
      now: params.now,
    });
    return {
      kind: action.kind,
      policy,
      mutationResult: result,
      auditRecord: result.auditRecord,
    } as unknown as Record<string, unknown>;
  }

  if (action.kind === 'app_action') {
    const request = buildApprovedAppActionRequestFromProposal({
      proposal: params.proposal,
      sessionPath: params.sessionPath,
      decisionId: params.decisionId,
      now: params.now,
    });
    const policy = evaluateAoiApprovedAppActionPolicy(request, { now: params.now });
    if (!policy.allowed) {
      throw new Error(`app_action_blocked:${policy.blockReasons.join(',')}`);
    }
    const result = applyAoiApprovedAppAction(request, {
      workspaceRoot: params.workspaceRoot,
      ...(params.approvedAppActionPolicy ? { approvedPolicy: params.approvedAppActionPolicy } : {}),
      now: params.now,
    });
    return {
      kind: action.kind,
      policy,
      appActionResult: result,
      auditRecord: result.auditRecord,
    } as unknown as Record<string, unknown>;
  }

  if (action.kind === 'connector_call') {
    const request = buildApprovedConnectorCallRequestFromProposal({
      proposal: params.proposal,
      sessionPath: params.sessionPath,
      decisionId: params.decisionId,
      now: params.now,
    });
    const connectors = params.connectors ?? null;
    // Hard env gate (OFF by default). When unset, a side-effecting tool is blocked by
    // the policy with `side_effecting_live_rpc_not_enabled`; when set, the policy
    // additionally requires the per-call irreversibility acknowledgment. The gate
    // value is threaded identically into the runner so the execute-time re-evaluation
    // agrees.
    const allowSideEffecting = isAoiSideEffectingLiveRpcEnabled();
    const policy = evaluateAoiApprovedConnectorCallPolicy(request, {
      connectors,
      now: params.now,
      ...(allowSideEffecting ? { allowSideEffecting: true } : {}),
    });
    if (!policy.allowed) {
      throw new Error(`connector_call_blocked:${policy.blockReasons.join(',')}`);
    }
    const result = await (
      params.dependencies.runApprovedConnectorCall ??
      ((runnerParams: {
        request: AoiApprovedConnectorCallRequest;
        approvedPolicy?: AoiApprovedConnectorCallPolicy;
        connectors: AoiMcpConnectorsConfig | null;
        now: number;
      }) =>
        applyAoiApprovedConnectorCall(runnerParams.request, {
          connectors: runnerParams.connectors,
          ...(runnerParams.approvedPolicy ? { approvedPolicy: runnerParams.approvedPolicy } : {}),
          ...(allowSideEffecting ? { allowSideEffecting: true } : {}),
          now: runnerParams.now,
        }))
    )({
      request,
      ...(params.approvedConnectorCallPolicy
        ? { approvedPolicy: params.approvedConnectorCallPolicy }
        : {}),
      connectors,
      now: params.now,
    });
    return {
      kind: action.kind,
      policy,
      connectorCallResult: result,
      auditRecord: result.auditRecord,
    } as unknown as Record<string, unknown>;
  }

  throw new Error(`Unsupported proposal action kind: ${action.kind}`);
}

function findActiveProposalOrThrow(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
}): AoiProposal {
  const proposals = loadAoiActiveProposals(params.sessionsDir, params.sessionPath);
  const proposal = proposals.find((item) => item.id === params.proposalId);
  if (!proposal) {
    throw new Error('Aoi proposal not found.');
  }
  return proposal;
}

export function previewAoiProposal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
  now?: number;
}): AoiProposalPreviewResult {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const proposal = findActiveProposalOrThrow({
    sessionsDir: params.sessionsDir,
    sessionPath,
    proposalId: params.proposalId,
  });
  const policy = loadAoiAutonomyPolicy(params.sessionsDir, sessionPath);
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const preparedActionPlan = buildAoiPreparedActionPlan(proposal, { now });
  const approvedCommandPolicy =
    proposal.acceptAction?.kind === 'run_command'
      ? evaluateAoiApprovedCommandPolicy(
          buildApprovedCommandRequestFromProposal({
            proposal,
            sessionPath,
            now,
          }),
        )
      : undefined;
  const boundedWorkOrder = buildAoiBoundedWorkOrderFromProposal(proposal, {
    now,
    generated: true,
  });
  const evaluation = evaluateAoiProposalExecution(proposal, policy, {
    now,
    decisions,
    executionMode: 'preview',
  });
  if (!evaluation.allowed || preparedActionPlan.status === 'blocked') {
    const reasons = [
      ...evaluation.reasons,
      ...preparedActionPlan.blockers.map((blocker) => `prepared_plan_blocked:${blocker}`),
    ];
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'kira_handoff_policy_blocked',
        message: `Kira handoff preview blocked: ${reasons.join(', ')}.`,
        goalSummary: `Aoi Kira handoff: ${proposal.title}`,
        toolNames: ['create_kira_work'],
        status: 'failed',
        now,
      });
    }
    if (proposal.acceptAction?.kind === 'run_command') {
      recordAoiExecutionTimelineBestEffort(() => {
        recordAoiOperatorTimelineEvent(params.sessionsDir, {
          sessionPath,
          kind: 'approved_command_previewed',
          visibility: 'operator_visible',
          createdAt: now,
          title: 'Approved command preview blocked',
          summary: `Command preview blocked for proposal ${proposal.id}.`,
          proposalId: proposal.id,
          actionKind: 'run_command',
          status: 'blocked',
          risk: proposal.risk,
          evidenceRefs: proposal.evidenceRefs,
          relatedRefs: [`proposal:${proposal.id}`],
          metadata: {
            allowed: false,
            reasons,
            blockReasons: approvedCommandPolicy?.blockReasons,
          },
        });
      });
    }
    return {
      ok: true,
      sessionPath,
      proposal,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
      previewed: false,
      outcome: 'blocked',
      reasons: [...new Set(reasons)],
      preparedActionPlan,
      ...(approvedCommandPolicy ? { approvedCommandPolicy } : {}),
      boundedWorkOrder,
      result: {
        preparedActionPlan,
        ...(approvedCommandPolicy ? { approvedCommandPolicy } : {}),
        boundedWorkOrder,
        safeAlternative:
          evaluation.safeAlternative ??
          (proposal.acceptAction?.kind === 'create_kira_work'
            ? getAoiKiraSafeNarrowingSuggestion()
            : undefined),
      },
    };
  }
  if (proposal.acceptAction?.kind !== 'create_kira_work') {
    if (proposal.acceptAction?.kind === 'run_command') {
      recordAoiExecutionTimelineBestEffort(() => {
        recordAoiOperatorTimelineEvent(params.sessionsDir, {
          sessionPath,
          kind: 'approved_command_previewed',
          visibility: 'operator_visible',
          createdAt: now,
          title: 'Approved command preview ready',
          summary: `Command preview ready for proposal ${proposal.id}.`,
          proposalId: proposal.id,
          actionKind: 'run_command',
          status: 'previewed',
          risk: proposal.risk,
          evidenceRefs: proposal.evidenceRefs,
          relatedRefs: [`proposal:${proposal.id}`],
          metadata: {
            allowed: approvedCommandPolicy?.allowed ?? false,
            blockReasons: approvedCommandPolicy?.blockReasons,
          },
        });
      });
    }
    return {
      ok: true,
      sessionPath,
      proposal,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
      previewed: true,
      outcome: 'previewed',
      reasons: [],
      preparedActionPlan,
      ...(approvedCommandPolicy ? { approvedCommandPolicy } : {}),
      boundedWorkOrder,
      result: {
        preparedActionPlan,
        ...(approvedCommandPolicy ? { approvedCommandPolicy } : {}),
        boundedWorkOrder,
      },
    };
  }

  const preview = buildAoiKiraHandoffPreview(proposal, { now });
  recordServerAoiRunLedgerEvent({
    sessionsDir: params.sessionsDir,
    sessionPath,
    type: 'kira_handoff_preview_created',
    message: `Kira handoff preview created for proposal ${proposal.id}.`,
    goalSummary: `Aoi Kira handoff: ${proposal.title}`,
    toolNames: ['create_kira_work'],
    now,
  });
  return {
    ok: true,
    sessionPath,
    proposal,
    status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
    previewed: true,
    outcome: 'previewed',
    reasons: [],
    preparedActionPlan,
    boundedWorkOrder,
    result: {
      preview: preview as unknown as Record<string, unknown>,
      preparedActionPlan,
      boundedWorkOrder,
    },
  };
}

export async function executeAoiProposal(params: {
  sessionsDir: string;
  configFile: string;
  serverOrigin: string;
  workspaceRoot?: string;
  sessionPath: string;
  proposalId: string;
  decisionId?: string;
  now?: number;
  dependencies?: AoiProposalExecutionDependencies;
}): Promise<AoiProposalExecutionResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const proposal = findActiveProposalOrThrow({
    sessionsDir: params.sessionsDir,
    sessionPath,
    proposalId: params.proposalId,
  });

  const policy = loadAoiAutonomyPolicy(params.sessionsDir, sessionPath);
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const approvedCommandPolicyForExecution =
    proposal.acceptAction?.kind === 'run_command'
      ? normalizeAoiApprovedCommandPolicy(
          decisions.find(
            (decision) =>
              decision.proposalId === proposal.id &&
              decision.action === 'accept' &&
              (!params.decisionId || decision.id === params.decisionId),
          )?.approvedCommand,
        )
      : undefined;
  const approvedFileMutationPolicyForExecution =
    proposal.acceptAction?.kind === 'file_write' ||
    proposal.acceptAction?.kind === 'file_patch' ||
    proposal.acceptAction?.kind === 'file_delete'
      ? normalizeAoiApprovedFileMutationPolicy(
          decisions.find(
            (decision) =>
              decision.proposalId === proposal.id &&
              decision.action === 'accept' &&
              (!params.decisionId || decision.id === params.decisionId),
          )?.approvedFileMutation,
        )
      : undefined;
  const approvedAppActionPolicyForExecution =
    proposal.acceptAction?.kind === 'app_action'
      ? normalizeAoiApprovedAppActionPolicy(
          decisions.find(
            (decision) =>
              decision.proposalId === proposal.id &&
              decision.action === 'accept' &&
              (!params.decisionId || decision.id === params.decisionId),
          )?.approvedAppAction,
        )
      : undefined;
  const approvedConnectorCallPolicyForExecution =
    proposal.acceptAction?.kind === 'connector_call'
      ? normalizeAoiApprovedConnectorCallPolicy(
          decisions.find(
            (decision) =>
              decision.proposalId === proposal.id &&
              decision.action === 'accept' &&
              (!params.decisionId || decision.id === params.decisionId),
          )?.approvedConnectorCall,
        )
      : undefined;
  // Server-readable trusted connector allow-list; the live trust authority for a
  // connector_call. Read once and shared by the execution gate and the runner.
  const connectors = loadAoiMcpConnectorsFromConfigFile(params.configFile);
  // Hard env gate (OFF by default) for side-effecting live RPC; resolved once and
  // shared by the execution gate and the connector_call runner so they agree.
  const allowSideEffecting = isAoiSideEffectingLiveRpcEnabled();
  // P2/B3-2 trust-bounded approval TTL (OFF by default). For an eligible pure
  // app_operation, when the field-evidence readiness is at the trusted_operator rung, the
  // strict 10min fresh-acceptance window is widened to a configurable validity window so
  // the loop can act within it without a fresh human click. Cost-gated: the readiness
  // scorecard is built ONLY when the flag is on AND the action is eligible (OFF -> no I/O).
  const approvalTtlEnabled = isAoiApprovalTtlEnabled();
  const eligibleAppOperationForTtl =
    proposal.acceptAction?.kind === 'app_action' &&
    approvedAppActionPolicyForExecution?.routing === 'app_operation';
  const buildReadinessScorecard =
    params.dependencies?.readReadinessScorecard ?? buildAoiAutonomyLevelPromotionScorecard;
  const approvalTtlScorecard =
    approvalTtlEnabled && eligibleAppOperationForTtl
      ? buildReadinessScorecard(params.sessionsDir, sessionPath, now)
      : null;
  const approvalWindowMs = resolveAoiApprovalTtlWindowMs({
    enabled: approvalTtlEnabled,
    eligibleAppOperation: eligibleAppOperationForTtl,
    scorecard: approvalTtlScorecard,
  });
  // P2/B3-3 defense in depth: a side-effecting connector call requires field-proven
  // trusted_operator readiness IN ADDITION to the env gate + irreversibility ack. Cost-
  // gated: re-resolve the (resolution-dependent) routing first, and build the readiness
  // scorecard ONLY for a side-effecting call under the env gate (read-only -> no I/O).
  const sideEffectingConnectorCall =
    proposal.acceptAction?.kind === 'connector_call' &&
    allowSideEffecting &&
    getAoiApprovedConnectorCallPolicyForProposal(proposal, now, connectors, true).routing ===
      'side_effecting';
  const sideEffectingConnectorTrustSatisfied = sideEffectingConnectorCall
    ? isAoiTrustedOperatorReadiness(buildReadinessScorecard(params.sessionsDir, sessionPath, now))
    : undefined;
  const evaluation = evaluateAoiProposalExecution(proposal, policy, {
    now,
    decisions,
    decisionId: params.decisionId,
    connectors,
    ...(allowSideEffecting ? { allowSideEffecting: true } : {}),
    ...(approvalWindowMs !== null ? { approvalValidityMs: approvalWindowMs } : {}),
    ...(sideEffectingConnectorTrustSatisfied !== undefined
      ? { sideEffectingConnectorTrustSatisfied }
      : {}),
  });
  if (!evaluation.allowed) {
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'kira_handoff_policy_blocked',
        message: `Kira handoff execution blocked: ${evaluation.reasons.join(', ')}.`,
        goalSummary: `Aoi Kira handoff: ${proposal.title}`,
        toolNames: ['create_kira_work'],
        status: 'failed',
        now,
      });
    }
    return blockProposal({
      sessionsDir: params.sessionsDir,
      sessionPath,
      proposalId: proposal.id,
      reason: evaluation.reasons.join(', '),
      now,
      outcome: 'blocked',
      ...(evaluation.safeAlternative
        ? {
            result: {
              safeAlternative: evaluation.safeAlternative,
            },
          }
        : {}),
    });
  }

  // P2/B3-2: stamp an audit marker ONLY when the trust-bounded window was actually the
  // reason this passed -- i.e. the loop acted on a stale approval (youngest accept older
  // than the strict 10min) without a fresh click. A fresh click within 10min records
  // nothing new.
  if (
    approvalWindowMs !== null &&
    wasAoiApprovalTtlWindowUsed({
      decisions,
      proposalId: proposal.id,
      decisionId: params.decisionId,
      now,
      freshAcceptanceMs: FRESH_ACCEPTANCE_MS,
    })
  ) {
    recordServerAoiRunLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath,
      type: 'approval_window_used',
      message: `App operation executed under the trust-bounded approval window (${approvalWindowMs}ms) without a fresh acceptance.`,
      goalSummary: `Aoi approval TTL: ${proposal.title}`,
      toolNames: [proposal.acceptAction?.kind ?? 'app_action'],
      now,
    });
  }

  try {
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'kira_handoff_execution_approved',
        message: `Kira handoff execution approved for proposal ${proposal.id}.`,
        goalSummary: `Aoi Kira handoff: ${proposal.title}`,
        toolNames: ['create_kira_work'],
        now,
      });
    }
    const result = await executeAllowedProposalAction({
      sessionsDir: params.sessionsDir,
      configFile: params.configFile,
      serverOrigin: params.serverOrigin,
      workspaceRoot: params.workspaceRoot ?? process.cwd(),
      sessionPath,
      proposal,
      decisionId: params.decisionId,
      ...(approvedCommandPolicyForExecution
        ? { approvedCommandPolicy: approvedCommandPolicyForExecution }
        : {}),
      ...(approvedFileMutationPolicyForExecution
        ? { approvedFileMutationPolicy: approvedFileMutationPolicyForExecution }
        : {}),
      ...(approvedAppActionPolicyForExecution
        ? { approvedAppActionPolicy: approvedAppActionPolicyForExecution }
        : {}),
      ...(approvedConnectorCallPolicyForExecution
        ? { approvedConnectorCallPolicy: approvedConnectorCallPolicyForExecution }
        : {}),
      connectors,
      dependencies: params.dependencies ?? {},
      now,
    });
    const transition = applyAoiProposalExecutionTransition(params.sessionsDir, sessionPath, {
      proposalId: proposal.id,
      nextStatus: 'executed',
      actor: 'system',
      reason: `Executed ${proposal.acceptAction?.kind ?? 'proposal action'}.`,
      now,
    });
    recordAoiExecutionTimelineBestEffort(() => {
      recordAoiProposalDecisionTimelineEvent({
        sessionsDir: params.sessionsDir,
        proposal: transition.proposal,
        decision: transition.decision,
      });
    });
    if (proposal.acceptAction?.kind === 'start_research') {
      const run = result.run as { id?: unknown } | undefined;
      if (typeof run?.id === 'string') {
        recordAoiResearchFollowupExecutionRelations({
          sessionsDir: params.sessionsDir,
          sessionPath,
          proposal,
          runId: run.id,
          priorRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
          now,
        });
      }
    }
    if (proposal.acceptAction?.kind === 'save_memory') {
      const memories = Array.isArray(result.memories) ? result.memories : [];
      const targetMemory = memories.find(
        (memory): memory is { id: string } =>
          Boolean(memory) &&
          typeof memory === 'object' &&
          typeof (memory as { id?: unknown }).id === 'string',
      );
      recordAoiProcedurePromotionRelations({
        sessionsDir: params.sessionsDir,
        sessionPath,
        procedureId: proposal.id,
        targetRef: targetMemory ? `memory:${targetMemory.id}` : `procedure:${proposal.id}:skill`,
        sourceRefs: [
          `proposal:${proposal.id}`,
          `decision:${transition.decision.id}`,
          ...proposal.evidenceRefs,
          ...proposal.artifactRefs,
        ],
        decisionId: transition.decision.id,
        now,
      });
      try {
        ingestAoiObservation(
          params.sessionsDir,
          {
            source: 'proposal',
            sessionPath,
            stableKey: `procedure-promotion:${proposal.id}:${transition.decision.id}`,
            createdAt: now,
            summary: `Procedure promotion executed from proposal "${proposal.title}".`,
            payloadRef: `decision:${transition.decision.id}`,
            memoryIds: targetMemory ? [targetMemory.id] : [],
            artifactRefs: [
              `procedure:${proposal.id}`,
              targetMemory ? `memory:${targetMemory.id}` : `procedure:${proposal.id}:skill`,
              `decision:${transition.decision.id}`,
            ],
            proposalIds: [proposal.id],
            riskSignals: [...proposal.riskSignals, 'procedure-promoted'],
          },
          { now },
        );
      } catch (error) {
        console.warn(
          '[AoiAutonomyExecution] Failed to ingest procedure promotion observation',
          error,
        );
      }
    }
    if (proposal.acceptAction?.kind === 'run_command') {
      const commandResult = result.commandResult;
      if (!isAoiApprovedCommandResult(commandResult)) {
        throw new Error('Approved command result was missing from execution output.');
      }
      const audit = appendAoiCommandAuditRecord(params.sessionsDir, {
        ...commandResult.auditRecord,
        evidenceRefs: [
          ...new Set([
            ...commandResult.auditRecord.evidenceRefs,
            `decision:${transition.decision.id}`,
            ...proposal.evidenceRefs,
            ...proposal.artifactRefs,
          ]),
        ].slice(0, 24),
      });
      const validationSnapshot = recordAoiValidationSignal({
        sessionsDir: params.sessionsDir,
        sessionPath,
        signal: {
          command: commandResult.command,
          result: commandResult.ok ? 'passed' : 'failed',
          completedAt: audit.completedAt,
          touchedFileScopes: inferCommandValidationScopes(proposal, result),
          evidenceRefs: audit.evidenceRefs,
        },
        now,
      });
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'approved_command_executed',
        message: `Approved command ${commandResult.ok ? 'passed' : 'failed'}: ${
          commandResult.command
        }`,
        goalSummary: `Aoi approved command: ${proposal.title}`,
        toolNames: ['run_command'],
        status: commandResult.ok ? 'completed' : 'failed',
        now,
      });
      recordAoiExecutionTimelineBestEffort(() => {
        recordAoiOperatorTimelineEvent(params.sessionsDir, {
          sessionPath,
          kind: 'approved_command_recorded',
          visibility: 'operator_visible',
          createdAt: audit.completedAt,
          title: commandResult.ok ? 'Approved command passed' : 'Approved command failed',
          summary: `Approved command audit ${audit.id} recorded for proposal ${proposal.id}.`,
          proposalId: proposal.id,
          decisionId: transition.decision.id,
          commandAuditId: audit.id,
          actionKind: 'run_command',
          status: commandResult.ok ? 'passed' : 'failed',
          risk: proposal.risk,
          evidenceRefs: audit.evidenceRefs,
          relatedRefs: [
            `proposal:${proposal.id}`,
            `decision:${transition.decision.id}`,
            `aoi-command-audit:${audit.id}`,
          ],
          metrics: {
            durationMs: audit.durationMs,
          },
          metadata: {
            exitCode: audit.exitCode ?? -1,
            timedOut: audit.timedOut,
            stdoutTruncated: audit.stdoutTruncated,
            stderrTruncated: audit.stderrTruncated,
          },
        });
      });
      try {
        ingestAoiObservation(
          params.sessionsDir,
          {
            source: 'tool',
            sessionPath,
            stableKey: `approved-command:${audit.id}`,
            createdAt: audit.completedAt,
            summary: `Approved command ${commandResult.ok ? 'passed' : 'failed'}: ${
              commandResult.command
            }`,
            payloadRef: `aoi-command-audit:${audit.id}`,
            memoryIds: [],
            artifactRefs: [
              `aoi-command-audit:${audit.id}`,
              `decision:${transition.decision.id}`,
              `workspace:validation:${validationSnapshot.validation.freshness}`,
              ...audit.evidenceRefs,
            ],
            proposalIds: [proposal.id],
            riskSignals: [
              'approved-command',
              commandResult.ok ? 'workspace-validation:passed' : 'workspace-validation:failed',
              ...(commandResult.timedOut ? ['workspace-validation:timeout'] : []),
            ],
          },
          { now: audit.completedAt },
        );
      } catch (error) {
        console.warn('[AoiAutonomyExecution] Failed to ingest approved command observation', error);
      }
    }
    if (
      proposal.acceptAction?.kind === 'file_write' ||
      proposal.acceptAction?.kind === 'file_patch' ||
      proposal.acceptAction?.kind === 'file_delete'
    ) {
      const mutationResult = result.mutationResult;
      if (!isAoiApprovedFileMutationResult(mutationResult)) {
        throw new Error('File mutation result was missing from execution output.');
      }
      const audit = appendAoiFileMutationAuditRecord(params.sessionsDir, {
        ...mutationResult.auditRecord,
        evidenceRefs: [
          ...new Set([
            ...mutationResult.auditRecord.evidenceRefs,
            `decision:${transition.decision.id}`,
            ...proposal.evidenceRefs,
            ...proposal.artifactRefs,
          ]),
        ].slice(0, 24),
      });
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'file_mutation_executed',
        message: `File ${mutationResult.operation} ${
          mutationResult.ok ? 'applied' : mutationResult.rolledBack ? 'rolled back' : 'blocked'
        }: ${mutationResult.pathLabel}`,
        goalSummary: `Aoi file mutation: ${proposal.title}`,
        toolNames: [proposal.acceptAction.kind],
        status: mutationResult.ok ? 'completed' : 'failed',
        now,
      });
      try {
        ingestAoiObservation(
          params.sessionsDir,
          {
            source: 'tool',
            sessionPath,
            stableKey: `file-mutation:${audit.id}`,
            createdAt: audit.completedAt,
            summary: `File ${mutationResult.operation} ${
              mutationResult.ok ? 'applied' : mutationResult.rolledBack ? 'rolled back' : 'blocked'
            }: ${mutationResult.pathLabel}`,
            payloadRef: `aoi-file-mutation-audit:${audit.id}`,
            memoryIds: [],
            artifactRefs: [
              `aoi-file-mutation-audit:${audit.id}`,
              `decision:${transition.decision.id}`,
              ...(mutationResult.checkpointId
                ? [`aoi-action-checkpoint:${mutationResult.checkpointId}`]
                : []),
              ...audit.evidenceRefs,
            ],
            proposalIds: [proposal.id],
            riskSignals: [
              'file-mutation',
              mutationResult.ok ? 'file-mutation:applied' : 'file-mutation:failed',
              ...(mutationResult.rolledBack ? ['file-mutation:rolled-back'] : []),
            ],
          },
          { now: audit.completedAt },
        );
      } catch (error) {
        console.warn('[AoiAutonomyExecution] Failed to ingest file mutation observation', error);
      }
    }
    if (proposal.acceptAction?.kind === 'app_action') {
      const appActionResult = result.appActionResult;
      if (!isAoiApprovedAppActionResult(appActionResult)) {
        throw new Error('App action result was missing from execution output.');
      }
      // app_operation routing cannot be dispatched server-side. By default it is
      // handed off to a Kira-style review; when live dispatch is opted in (B3-1) it
      // is instead QUEUED for client-mediated dispatch over the agent->app bus.
      // file_backed routing already mutated on disk and never reaches this branch.
      let kiraWorkRef: string | undefined;
      let appOpDispatchId: string | undefined;
      if (appActionResult.reviewHandoff) {
        const queued = maybeQueueAppOperationDispatch({
          sessionsDir: params.sessionsDir,
          sessionPath,
          proposal,
          decisionId: transition.decision.id,
          policy: approvedAppActionPolicyForExecution,
          appActionResult,
          now,
        });
        if (queued) {
          appOpDispatchId = queued.id;
        } else {
          try {
            const preview = buildAoiKiraHandoffPreview(proposal, { now });
            const createKiraWork =
              params.dependencies?.createKiraWork ?? createDefaultKiraWorkFromPreview;
            const kiraWork = createKiraWork({
              sessionsDir: params.sessionsDir,
              sessionPath,
              proposal,
              preview,
              now,
            });
            kiraWorkRef = kiraWork.work.ref;
            recordAoiKiraHandoffRelations({
              sessionsDir: params.sessionsDir,
              sessionPath,
              proposal,
              workRef: kiraWork.work.ref,
              workTitle: kiraWork.work.title,
              decisionId: transition.decision.id,
              evidenceRefs: [...preview.evidenceRefs],
              goalRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs].filter(
                (ref) => ref.startsWith('goal:') || ref.startsWith('plan-step:'),
              ),
              now,
            });
          } catch (error) {
            console.warn(
              '[AoiAutonomyExecution] Failed to create Kira review handoff for app action',
              error,
            );
          }
        }
      }
      const appOpDispatchRef = appOpDispatchId
        ? `aoi-app-op-dispatch:${appOpDispatchId}`
        : undefined;
      const audit = appendAoiAppActionAuditRecord(params.sessionsDir, {
        ...appActionResult.auditRecord,
        ...(kiraWorkRef ? { kiraWorkRef } : {}),
        evidenceRefs: [
          ...new Set([
            ...appActionResult.auditRecord.evidenceRefs,
            `decision:${transition.decision.id}`,
            ...(kiraWorkRef ? [kiraWorkRef] : []),
            ...(appOpDispatchRef ? [appOpDispatchRef] : []),
            ...proposal.evidenceRefs,
            ...proposal.artifactRefs,
          ]),
        ].slice(0, 24),
      });
      const appActionStatusLabel = appActionResult.reviewHandoff
        ? appOpDispatchId
          ? 'queued for live dispatch'
          : 'handed off to Kira review'
        : appActionResult.ok
          ? 'applied'
          : appActionResult.rolledBack
            ? 'rolled back'
            : 'blocked';
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'app_action_executed',
        message: `App action ${appActionResult.capabilityId} (${appActionResult.executionKind}) ${appActionStatusLabel}.`,
        goalSummary: `Aoi app action: ${proposal.title}`,
        toolNames: [proposal.acceptAction.kind],
        status: appActionResult.ok ? 'completed' : 'failed',
        now,
      });
      try {
        ingestAoiObservation(
          params.sessionsDir,
          {
            source: 'tool',
            sessionPath,
            stableKey: `app-action:${audit.id}`,
            createdAt: audit.completedAt,
            summary: `App action ${appActionResult.capabilityId} (${appActionResult.executionKind}) ${appActionStatusLabel}.`,
            payloadRef: `aoi-app-action-audit:${audit.id}`,
            memoryIds: [],
            artifactRefs: [
              `aoi-app-action-audit:${audit.id}`,
              `decision:${transition.decision.id}`,
              ...(kiraWorkRef ? [kiraWorkRef] : []),
              ...(appOpDispatchRef ? [appOpDispatchRef] : []),
              ...(appActionResult.checkpointId
                ? [`aoi-action-checkpoint:${appActionResult.checkpointId}`]
                : []),
              ...audit.evidenceRefs,
            ],
            proposalIds: [proposal.id],
            riskSignals: [
              'app-action',
              `app-action:${appActionResult.routing}`,
              appActionResult.reviewHandoff
                ? appOpDispatchId
                  ? 'app-action:queued-for-dispatch'
                  : 'app-action:review-handoff'
                : appActionResult.ok
                  ? 'app-action:applied'
                  : 'app-action:failed',
              ...(appActionResult.rolledBack ? ['app-action:rolled-back'] : []),
            ],
          },
          { now: audit.completedAt },
        );
      } catch (error) {
        console.warn('[AoiAutonomyExecution] Failed to ingest app action observation', error);
      }
    }
    if (proposal.acceptAction?.kind === 'connector_call') {
      const connectorCallResult = result.connectorCallResult;
      if (!isAoiApprovedConnectorCallResult(connectorCallResult)) {
        throw new Error('Connector call result was missing from execution output.');
      }
      const audit = appendAoiConnectorCallAuditRecord(params.sessionsDir, {
        ...connectorCallResult.auditRecord,
        evidenceRefs: [
          ...new Set([
            ...connectorCallResult.auditRecord.evidenceRefs,
            `decision:${transition.decision.id}`,
            ...proposal.evidenceRefs,
            ...proposal.artifactRefs,
          ]),
        ].slice(0, 24),
      });
      const connectorStatusLabel = connectorCallResult.applied
        ? 'invoked'
        : connectorCallResult.blockReasons.includes('execution_failed')
          ? 'failed'
          : 'blocked';
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'connector_call_executed',
        message: `Connector call ${connectorCallResult.toolName} on ${connectorCallResult.connectorId} (${connectorCallResult.routing}) ${connectorStatusLabel}.`,
        goalSummary: `Aoi connector call: ${proposal.title}`,
        toolNames: [proposal.acceptAction.kind],
        status: connectorCallResult.ok ? 'completed' : 'failed',
        now,
      });
      try {
        ingestAoiObservation(
          params.sessionsDir,
          {
            source: 'tool',
            sessionPath,
            stableKey: `connector-call:${audit.id}`,
            createdAt: audit.completedAt,
            summary: `Connector call ${connectorCallResult.toolName} on ${connectorCallResult.connectorId} (${connectorCallResult.routing}) ${connectorStatusLabel}.`,
            payloadRef: `aoi-connector-call-audit:${audit.id}`,
            memoryIds: [],
            artifactRefs: [
              `aoi-connector-call-audit:${audit.id}`,
              `decision:${transition.decision.id}`,
              ...audit.evidenceRefs,
            ],
            proposalIds: [proposal.id],
            riskSignals: [
              'connector-call',
              `connector-call:${connectorCallResult.routing}`,
              connectorCallResult.applied
                ? 'connector-call:invoked'
                : connectorCallResult.blockReasons.includes('execution_failed')
                  ? 'connector-call:failed'
                  : 'connector-call:blocked',
            ],
          },
          { now: audit.completedAt },
        );
      } catch (error) {
        console.warn('[AoiAutonomyExecution] Failed to ingest connector call observation', error);
      }
    }
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      const work = result.work as
        | { id?: unknown; ref?: unknown; title?: unknown; projectName?: unknown; status?: unknown }
        | undefined;
      const preview = result.preview as { evidenceRefs?: unknown } | undefined;
      const workRef = typeof work?.ref === 'string' ? work.ref : undefined;
      const workTitle = typeof work?.title === 'string' ? work.title : proposal.title;
      const evidenceRefs = Array.isArray(preview?.evidenceRefs)
        ? preview.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
        : [...proposal.evidenceRefs, ...proposal.artifactRefs];
      if (workRef) {
        recordAoiKiraHandoffRelations({
          sessionsDir: params.sessionsDir,
          sessionPath,
          proposal,
          workRef,
          workTitle,
          decisionId: transition.decision.id,
          evidenceRefs,
          goalRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs].filter(
            (ref) => ref.startsWith('goal:') || ref.startsWith('plan-step:'),
          ),
          now,
        });
        recordServerAoiRunLedgerEvent({
          sessionsDir: params.sessionsDir,
          sessionPath,
          type: 'kira_work_item_created',
          message: `Kira work item ${workRef} created from proposal ${proposal.id}.`,
          goalSummary: `Aoi Kira handoff: ${proposal.title}`,
          toolNames: ['create_kira_work'],
          now,
        });
        try {
          ingestAoiObservation(
            params.sessionsDir,
            {
              source: 'proposal',
              sessionPath,
              stableKey: `kira-handoff:${proposal.id}:${workRef}`,
              createdAt: now,
              summary: `Kira work item created from Aoi proposal "${proposal.title}".`,
              payloadRef: workRef,
              memoryIds: [],
              artifactRefs: [workRef, `decision:${transition.decision.id}`, ...evidenceRefs],
              proposalIds: [proposal.id],
              riskSignals: [...proposal.riskSignals, 'kira-handoff-created'],
            },
            { now },
          );
        } catch (error) {
          console.warn('[AoiAutonomyExecution] Failed to ingest Kira handoff observation', error);
        }
      }
    }
    return {
      ok: true,
      sessionPath,
      proposal: transition.proposal,
      decision: transition.decision,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
      executed: true,
      outcome: 'executed',
      reasons: [],
      result,
    };
  } catch (error) {
    return blockProposal({
      sessionsDir: params.sessionsDir,
      sessionPath,
      proposalId: proposal.id,
      reason: `execution_failed:${error instanceof Error ? error.message : String(error)}`,
      now,
      outcome: 'failed',
    });
  }
}
