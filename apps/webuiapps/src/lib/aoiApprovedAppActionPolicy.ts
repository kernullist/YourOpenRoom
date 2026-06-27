import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';
import { decideAoiCapabilityBrokerAuthority } from './aoiCapabilityRegistry';
import {
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
  normalizeAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import type { AppDef, AppIdentity } from './appRegistry';
import type { AppIntentExecutionKind } from './appIntentContracts';
import type {
  AoiApprovedAppActionPolicy,
  AoiApprovedAppActionRequest,
  AoiApprovedFileMutationPolicy,
  AoiApprovedFileMutationRequest,
  AoiAppActionBlockReason,
  AoiAppActionRouting,
  AoiAutonomyRisk,
  AoiFileMutationOperation,
  AoiFileMutationPatchOp,
} from './aoiAutonomyTypes';

// Policy + content-addressed approval fingerprint for approved Aoi app_action
// proposals. This is the app-capability analog of aoiApprovedFileMutationPolicy.ts.
// An app_action proposal flows through the capability broker
// (decideAoiCapabilityBrokerAuthority), which classifies an executionKind. The
// policy routes on that classification:
//   - file_backed (schema_file_write / schema_file_delete / state_file_write):
//     a reversible mutation of an app dataRoot file. The policy embeds an approved
//     file-mutation policy that the runner applies behind a pre-change checkpoint.
//   - app_operation (app_action / window_action): a live app operation the server
//     cannot dispatch; recovery is the app's own undo via a Kira-style review.
//     Not server-executable in this commit (blocked with a clear reason).
//
// This module is reachable from the client bundle via aoiAutonomyPolicy, so it
// must stay browser-safe (no Node 'crypto'). It reuses the FNV approach shared by
// the approval sandbox and the file-mutation policy. The broker and file-mutation
// policy it depends on are already client-safe.

export const AOI_APP_ACTION_APPROVAL_TTL_MS = 5 * 60 * 1000;

const MAX_PURPOSE_CHARS = 180;

// Browser-safe short hash (FNV-1a). Matches the command/file-mutation policies.
function hashStable(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Wider (64-bit) operation hash from two independent FNV-1a passes, so the
// content-addressed approval binding has a low collision rate without 'crypto'.
function hashAoiAppActionOperation(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x5bd1e995) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePurpose(value: unknown): string {
  const purpose =
    typeof value === 'string' ? normalizeWhitespace(value).slice(0, MAX_PURPOSE_CHARS) : '';
  return purpose || 'Trigger an approved Aoi app action.';
}

function normalizeReference(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOperationParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      result[key] = raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = String(raw);
    }
  }
  return result;
}

export function appActionRoutingForExecutionKind(
  executionKind: AppIntentExecutionKind | 'capability_manifest' | 'unknown',
): AoiAppActionRouting | null {
  if (
    executionKind === 'schema_file_write' ||
    executionKind === 'schema_file_delete' ||
    executionKind === 'state_file_write'
  ) {
    return 'file_backed';
  }
  if (executionKind === 'app_action' || executionKind === 'window_action') {
    return 'app_operation';
  }
  return null;
}

function fileMutationOperationForExecutionKind(
  executionKind: AppIntentExecutionKind | 'unknown',
  request: AoiApprovedAppActionRequest,
): AoiFileMutationOperation {
  if (executionKind === 'schema_file_delete') {
    return 'delete';
  }
  // A schema/state write may be expressed as a full-content write or, when only
  // anchored patch ops are supplied, an in-place patch.
  if (
    Array.isArray(request.patchOps) &&
    request.patchOps.length > 0 &&
    typeof request.content !== 'string'
  ) {
    return 'patch';
  }
  return 'write';
}

function dataRootForApp(appName: string): string {
  return `apps/${appName}/data`;
}

// Build the file-mutation request that backs a file_backed app action, keeping the
// operation-derivation rule in one place so the policy and the runner agree.
export function buildAoiAppActionFileMutationRequest(
  request: AoiApprovedAppActionRequest,
  executionKind: AppIntentExecutionKind | 'unknown',
): AoiApprovedFileMutationRequest {
  return createAoiApprovedFileMutationRequest({
    sessionPath: request.sessionPath,
    ...(request.proposalId ? { proposalId: request.proposalId } : {}),
    ...(request.decisionId ? { decisionId: request.decisionId } : {}),
    operation: fileMutationOperationForExecutionKind(executionKind, request),
    path: request.path,
    content: request.content,
    patchOps: request.patchOps,
    purpose: normalizePurpose(request.purpose),
    risk: request.risk,
    requestedAt: request.requestedAt,
    evidenceRefs: request.evidenceRefs,
  });
}

function isPathInsideDataRoot(pathLabel: string, dataRoot: string): boolean {
  return pathLabel === dataRoot || pathLabel.startsWith(`${dataRoot}/`);
}

export function createAoiApprovedAppActionRequest(params: {
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  appReference: unknown;
  capabilityId?: unknown;
  intentReference?: unknown;
  actionType?: unknown;
  requestedOperation?: unknown;
  operationParams?: unknown;
  path?: unknown;
  content?: unknown;
  patchOps?: unknown;
  purpose?: unknown;
  risk?: AoiAutonomyRisk;
  requestedAt?: number;
  evidenceRefs?: string[];
}): AoiApprovedAppActionRequest {
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(params.proposalId ? { proposalId: params.proposalId } : {}),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
    appReference: normalizeReference(params.appReference),
    ...(normalizeReference(params.capabilityId)
      ? { capabilityId: normalizeReference(params.capabilityId) }
      : {}),
    ...(normalizeReference(params.intentReference)
      ? { intentReference: normalizeReference(params.intentReference) }
      : {}),
    ...(normalizeReference(params.actionType)
      ? { actionType: normalizeReference(params.actionType) }
      : {}),
    ...(normalizeReference(params.requestedOperation)
      ? { requestedOperation: normalizeReference(params.requestedOperation) }
      : {}),
    ...(params.operationParams
      ? { operationParams: normalizeOperationParams(params.operationParams) }
      : {}),
    ...(typeof params.path === 'string' ? { path: params.path } : {}),
    ...(typeof params.content === 'string' ? { content: params.content } : {}),
    ...(Array.isArray(params.patchOps)
      ? { patchOps: params.patchOps as AoiFileMutationPatchOp[] }
      : {}),
    purpose: normalizePurpose(params.purpose),
    risk: params.risk ?? 'high',
    requestedAt: params.requestedAt ?? Date.now(),
    evidenceRefs: [...new Set(params.evidenceRefs ?? [])].slice(0, 16),
  };
}

function hasCapabilityReference(request: AoiApprovedAppActionRequest): boolean {
  return Boolean(
    request.capabilityId ||
    request.intentReference ||
    request.actionType ||
    request.requestedOperation,
  );
}

function sortedOperationParams(value: Record<string, string> | undefined): Array<[string, string]> {
  if (!value) {
    return [];
  }
  return Object.entries(value).sort((left, right) => left[0].localeCompare(right[0]));
}

export function evaluateAoiApprovedAppActionPolicy(
  request: AoiApprovedAppActionRequest,
  options: { apps?: readonly (AppDef | AppIdentity)[]; now?: number } = {},
): AoiApprovedAppActionPolicy {
  const now = options.now ?? request.requestedAt;
  const purpose = normalizePurpose(request.purpose);
  const purposeHash = hashStable(purpose);
  const blockReasons: AoiAppActionBlockReason[] = [];

  if (!request.appReference) {
    blockReasons.push('missing_app_reference');
  }
  if (!hasCapabilityReference(request)) {
    blockReasons.push('missing_capability_reference');
  }

  // Resolve the capability classification via the broker on a non-execute band so
  // the broker's own execute-gate reasons do not leak into this policy. This
  // policy owns the L5 + content-addressed + fresh-acceptance gate.
  const decision = decideAoiCapabilityBrokerAuthority({
    appReference: request.appReference || 'unknown',
    ...(request.capabilityId ? { capabilityId: request.capabilityId } : {}),
    ...(request.intentReference ? { intentReference: request.intentReference } : {}),
    ...(request.actionType ? { actionType: request.actionType } : {}),
    ...(request.requestedOperation ? { requestedOperation: request.requestedOperation } : {}),
    requestedBand: 'prepare',
    ...(options.apps ? { apps: options.apps } : {}),
    now,
  });

  const appName = decision.appName;
  const appId = decision.appId;
  const capabilityId = decision.capabilityId;
  const executionKind =
    decision.executionKind === 'capability_manifest' ? 'unknown' : decision.executionKind;
  const mutationCapable = decision.mutationCapable;

  const capabilityUnknown =
    executionKind === 'unknown' ||
    capabilityId === 'unknown' ||
    decision.blockedReasons.some(
      (reason) =>
        reason === 'unknown_capability' || reason === 'unknown_app_or_capability_manifest',
    );
  if (capabilityUnknown && !blockReasons.includes('missing_capability_reference')) {
    blockReasons.push('unknown_app_or_capability');
  }

  const routing = capabilityUnknown ? null : appActionRoutingForExecutionKind(executionKind);
  if (!capabilityUnknown && !routing) {
    blockReasons.push('unsupported_execution_kind');
  }

  const resolvedRouting: AoiAppActionRouting = routing ?? 'app_operation';
  const dataRoot = appName ? dataRootForApp(appName) : undefined;

  let fileMutation: AoiApprovedFileMutationPolicy | undefined;
  let operationHashSeed: string;

  if (resolvedRouting === 'file_backed' && blockReasons.length === 0) {
    const operation = fileMutationOperationForExecutionKind(executionKind, request);
    const fileRequest = buildAoiAppActionFileMutationRequest(request, executionKind);
    const filePolicy = evaluateAoiApprovedFileMutationPolicy(fileRequest);
    fileMutation = filePolicy;
    if (!dataRoot) {
      blockReasons.push('missing_data_root');
    } else if (!isPathInsideDataRoot(filePolicy.pathLabel, dataRoot)) {
      blockReasons.push('path_outside_data_root');
    }
    if (!filePolicy.allowed) {
      blockReasons.push('file_mutation_blocked');
    }
    operationHashSeed = [
      appName,
      capabilityId,
      executionKind,
      operation,
      filePolicy.pathLabel,
      filePolicy.contentHash,
    ].join('|');
  } else if (resolvedRouting === 'app_operation' && !capabilityUnknown && routing) {
    // Pure app operation: the server cannot dispatch a live app operation, so it
    // is handed off to a Kira-style review. No server-side file mutation; recovery
    // is the app's own undo. The operation is bound by action + operation params.
    operationHashSeed = [
      appName,
      capabilityId,
      executionKind,
      request.actionType ?? '',
      JSON.stringify(sortedOperationParams(request.operationParams)),
    ].join('|');
  } else {
    operationHashSeed = [appName, capabilityId, executionKind, request.actionType ?? ''].join('|');
  }

  const operationHash = hashAoiAppActionOperation(operationHashSeed);
  // file_backed mutates one dataRoot file on the server. app_operation makes no
  // direct server mutation (it produces a Kira review artifact), so it stays 0
  // and the display_only / mutationCount:0 invariant holds for the live app op.
  const expectedMutationCount = resolvedRouting === 'file_backed' ? 1 : 0;
  const operationLabel = `${decision.displayName} ${capabilityId} (${executionKind})`;
  const dryRunSummary =
    resolvedRouting === 'file_backed'
      ? `Would apply an approved ${executionKind} mutation to ${fileMutation?.pathLabel ?? 'an app dataRoot file'} (op hash ${operationHash}).`
      : `Would hand off app operation ${capabilityId} (${executionKind}) to a Kira-style review; recovery is the app's own undo.`;

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'app',
    targetId: `${appName || request.appReference}:${capabilityId}`,
    intendedMutation: `${operationLabel} op hash ${operationHash}`,
    dryRunSummary,
    requiredAuthorityDecisionId: `approved-app-action:${hashStable(
      [appName, capabilityId, executionKind, operationHash, request.risk].join('|'),
    )}`,
    expectedMutationCount,
    recoveryPlan:
      resolvedRouting === 'file_backed'
        ? {
            kind: 'before_snapshot',
            available: true,
            summary:
              'A pre-change checkpoint of the target app dataRoot file is captured before applying and restored automatically if the mutation fails verification.',
            evidenceRefs: request.evidenceRefs,
          }
        : {
            kind: 'manual_recovery',
            available: true,
            summary:
              "Recovery for a pure app operation is the app's own undo via a Kira-style review handoff.",
            evidenceRefs: request.evidenceRefs,
          },
    rollback: {
      required: expectedMutationCount > 0,
      note:
        resolvedRouting === 'file_backed'
          ? 'The pre-change checkpoint is restored if the mutation fails or is later undone.'
          : "Reverting a pure app operation relies on the app's own undo under Kira review.",
      evidenceRefs: request.evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Record the app-action audit and validate the executed mutation count.',
      check: 'App-action audit receipt is recorded after execution.',
      evidenceRefs: request.evidenceRefs,
    },
    evidenceRefs: request.evidenceRefs,
  });

  const allowed = blockReasons.length === 0;
  return {
    version: 1,
    allowed,
    blockReasons: [...new Set(blockReasons)],
    appId,
    appName,
    capabilityId,
    executionKind,
    routing: resolvedRouting,
    mutationCapable,
    ...(dataRoot ? { dataRoot } : {}),
    ...(fileMutation ? { fileMutation } : {}),
    operationHash,
    purpose,
    purposeHash,
    risk: request.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_APP_ACTION_APPROVAL_TTL_MS,
    rationale: allowed
      ? [
          `Approved ${executionKind} app action ${capabilityId} on ${appName} under L5 with ${
            resolvedRouting === 'file_backed' ? 'a pre-change checkpoint' : 'a Kira-style review'
          }.`,
        ]
      : ['App action is blocked until it matches the approved app-action policy.'],
  };
}

export function normalizeAoiApprovedAppActionPolicy(
  value: unknown,
): AoiApprovedAppActionPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiApprovedAppActionPolicy>;
  if (
    raw.version !== 1 ||
    typeof raw.allowed !== 'boolean' ||
    !Array.isArray(raw.blockReasons) ||
    typeof raw.appName !== 'string' ||
    typeof raw.capabilityId !== 'string' ||
    typeof raw.executionKind !== 'string' ||
    (raw.routing !== 'file_backed' && raw.routing !== 'app_operation') ||
    typeof raw.mutationCapable !== 'boolean' ||
    typeof raw.operationHash !== 'string' ||
    typeof raw.purpose !== 'string' ||
    typeof raw.purposeHash !== 'string' ||
    (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high') ||
    raw.requiredAutonomyLevel !== 'L5' ||
    typeof raw.approvalFingerprint !== 'string' ||
    typeof raw.expiresAt !== 'number' ||
    !Array.isArray(raw.rationale)
  ) {
    return undefined;
  }
  const approvalSandbox = normalizeAoiApprovalSandboxPreview(raw.approvalSandbox);
  const fileMutation = normalizeAoiApprovedFileMutationPolicy(raw.fileMutation);
  return {
    version: 1,
    allowed: raw.allowed,
    blockReasons: raw.blockReasons.filter(
      (item): item is AoiAppActionBlockReason => typeof item === 'string',
    ),
    appId: typeof raw.appId === 'number' ? raw.appId : null,
    appName: raw.appName,
    capabilityId: raw.capabilityId,
    executionKind: raw.executionKind as AoiApprovedAppActionPolicy['executionKind'],
    routing: raw.routing,
    mutationCapable: raw.mutationCapable,
    ...(typeof raw.dataRoot === 'string' ? { dataRoot: raw.dataRoot } : {}),
    ...(fileMutation ? { fileMutation } : {}),
    operationHash: raw.operationHash,
    purpose: raw.purpose,
    purposeHash: raw.purposeHash,
    risk: raw.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: raw.approvalFingerprint,
    ...(approvalSandbox ? { approvalSandbox } : {}),
    expiresAt: raw.expiresAt,
    rationale: raw.rationale.filter((item): item is string => typeof item === 'string'),
  };
}

export function compareAoiApprovedAppActionApproval(params: {
  approved: AoiApprovedAppActionPolicy | undefined;
  current: AoiApprovedAppActionPolicy;
  now: number;
}): AoiAppActionBlockReason[] {
  const approved = params.approved;
  if (!approved) {
    return ['approval_missing', 'approval_sandbox_missing'];
  }
  const reasons: AoiAppActionBlockReason[] = [];
  if (approved.expiresAt < params.now) {
    reasons.push('approval_expired');
  }
  if (approved.appName !== params.current.appName || approved.appId !== params.current.appId) {
    reasons.push('approval_app_changed');
  }
  if (approved.capabilityId !== params.current.capabilityId) {
    reasons.push('approval_capability_changed');
  }
  if (approved.executionKind !== params.current.executionKind) {
    reasons.push('approval_execution_kind_changed');
  }
  if (approved.operationHash !== params.current.operationHash) {
    reasons.push('approval_operation_changed');
  }
  if (approved.risk !== params.current.risk) {
    reasons.push('approval_risk_changed');
  }
  if (approved.purposeHash !== params.current.purposeHash) {
    reasons.push('approval_purpose_changed');
  }
  for (const reason of compareAoiApprovalSandboxPreviews({
    approved: approved.approvalSandbox,
    current: params.current.approvalSandbox,
  })) {
    reasons.push(reason as AoiAppActionBlockReason);
  }
  if (
    approved.approvalFingerprint !== params.current.approvalFingerprint &&
    !reasons.includes('approval_operation_changed') &&
    !reasons.includes('approval_capability_changed')
  ) {
    reasons.push('approval_fingerprint_changed');
  }
  return [...new Set(reasons)];
}
