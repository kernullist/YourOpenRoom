import { createHash } from 'crypto';
import {
  buildAoiAppActionFileMutationRequest,
  compareAoiApprovedAppActionApproval,
  evaluateAoiApprovedAppActionPolicy,
} from './aoiApprovedAppActionPolicy';
import { applyAoiApprovedFileMutation } from './aoiApprovedFileMutationRunner';
import type { AppDef, AppIdentity } from './appRegistry';
import type {
  AoiApprovedAppActionPolicy,
  AoiApprovedAppActionRequest,
  AoiApprovedAppActionResult,
  AoiApprovedFileMutationResult,
  AoiAppActionAuditRecord,
  AoiAppActionBlockReason,
} from './aoiAutonomyTypes';

// Server-side runner that executes an approved Aoi app_action behind the
// capability broker's classification. Mirrors aoiApprovedFileMutationRunner.ts:
// re-derive the policy, validate the stored approval, then route by executionKind.
//
//   - file_backed routing: reuse applyAoiApprovedFileMutation so the mutation of
//     the app dataRoot file runs behind a pre-change checkpoint and is reversible.
//   - app_operation routing: the server cannot dispatch a live app operation and
//     cannot file-checkpoint it; that path is blocked here and handled by a
//     Kira-style review handoff in a follow-up commit.
//
// The returned result carries the underlying file-mutation result (and its
// checkpoint) so the execution layer can persist it for a later undo.

export interface AoiApprovedAppActionRunnerOptions {
  workspaceRoot: string;
  approvedPolicy?: AoiApprovedAppActionPolicy | null;
  apps?: readonly (AppDef | AppIdentity)[];
  now?: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeAuditId(request: AoiApprovedAppActionRequest, startedAt: number): string {
  return `aoi-app-action-${startedAt.toString(36)}-${sha256Hex(
    `${request.sessionPath}:${request.proposalId ?? ''}:${request.appReference}:${
      request.capabilityId ?? request.actionType ?? request.intentReference ?? ''
    }:${startedAt}`,
  ).slice(0, 16)}`;
}

interface AppActionOutcome {
  applied: boolean;
  rolledBack: boolean;
  reviewHandoff: boolean;
  blockReasons: AoiAppActionBlockReason[];
  fileMutationResult?: AoiApprovedFileMutationResult;
}

function buildResult(params: {
  request: AoiApprovedAppActionRequest;
  policy: AoiApprovedAppActionPolicy;
  startedAt: number;
  completedAt: number;
  outcome: AppActionOutcome;
}): AoiApprovedAppActionResult {
  const { request, policy, outcome } = params;
  const ok = outcome.applied && outcome.blockReasons.length === 0;
  const fileResult = outcome.fileMutationResult;
  const auditRecord: AoiAppActionAuditRecord = {
    version: 1,
    id: makeAuditId(request, params.startedAt),
    sessionPath: request.sessionPath,
    ...(request.proposalId ? { proposalId: request.proposalId } : {}),
    ...(request.decisionId ? { decisionId: request.decisionId } : {}),
    appName: policy.appName,
    capabilityId: policy.capabilityId,
    executionKind: policy.executionKind,
    routing: policy.routing,
    purpose: policy.purpose,
    risk: policy.risk,
    allowed: ok,
    blockReasons: [...new Set(outcome.blockReasons)],
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.completedAt - params.startedAt),
    applied: outcome.applied,
    rolledBack: outcome.rolledBack,
    reviewHandoff: outcome.reviewHandoff,
    operationHash: policy.operationHash,
    ...(fileResult ? { fileMutationAuditId: fileResult.auditRecord.id } : {}),
    ...(fileResult ? { pathLabel: fileResult.pathLabel } : {}),
    ...(fileResult?.checkpointId ? { checkpointId: fileResult.checkpointId } : {}),
    evidenceRefs: [
      ...new Set([
        `aoi-app-action-audit:${makeAuditId(request, params.startedAt)}`,
        ...(request.proposalId ? [`proposal:${request.proposalId}`] : []),
        ...(request.decisionId ? [`decision:${request.decisionId}`] : []),
        ...(fileResult ? [`aoi-file-mutation-audit:${fileResult.auditRecord.id}`] : []),
        ...(fileResult?.checkpointId ? [`aoi-action-checkpoint:${fileResult.checkpointId}`] : []),
        ...request.evidenceRefs,
      ]),
    ].slice(0, 24),
    approvalFingerprint: policy.approvalFingerprint,
    ...(policy.approvalSandbox
      ? { approvalSandboxPreviewHash: policy.approvalSandbox.previewHash }
      : {}),
    approvalSandboxValidationStatus: ok ? 'approved' : 'blocked',
  };
  return {
    version: 1,
    ok,
    appName: policy.appName,
    capabilityId: policy.capabilityId,
    executionKind: policy.executionKind,
    routing: policy.routing,
    applied: outcome.applied,
    rolledBack: outcome.rolledBack,
    reviewHandoff: outcome.reviewHandoff,
    ...(fileResult ? { fileMutationResult: fileResult } : {}),
    ...(fileResult ? { pathLabel: fileResult.pathLabel } : {}),
    ...(fileResult?.checkpointId ? { checkpointId: fileResult.checkpointId } : {}),
    ...(fileResult?.checkpoint ? { checkpoint: fileResult.checkpoint } : {}),
    blockReasons: auditRecord.blockReasons,
    auditRecord,
    evidenceRefs: auditRecord.evidenceRefs,
  };
}

export function applyAoiApprovedAppAction(
  request: AoiApprovedAppActionRequest,
  options: AoiApprovedAppActionRunnerOptions,
): AoiApprovedAppActionResult {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiApprovedAppActionPolicy(request, {
    ...(options.apps ? { apps: options.apps } : {}),
    now: startedAt,
  });
  const approvalReasons = compareAoiApprovedAppActionApproval({
    approved: options.approvedPolicy ?? undefined,
    current: policy,
    now: startedAt,
  });

  if (!policy.allowed || approvalReasons.length > 0) {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: startedAt,
      outcome: {
        applied: false,
        rolledBack: false,
        reviewHandoff: false,
        blockReasons: [...policy.blockReasons, ...approvalReasons],
      },
    });
  }

  if (policy.routing === 'file_backed') {
    const fileRequest = buildAoiAppActionFileMutationRequest(request, policy.executionKind);
    const fileResult = applyAoiApprovedFileMutation(fileRequest, {
      workspaceRoot: options.workspaceRoot,
      ...(options.approvedPolicy?.fileMutation
        ? { approvedPolicy: options.approvedPolicy.fileMutation }
        : {}),
      now: startedAt,
    });
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: fileResult.applied,
        rolledBack: fileResult.rolledBack,
        reviewHandoff: false,
        blockReasons: fileResult.ok ? [] : ['file_mutation_blocked'],
        fileMutationResult: fileResult,
      },
    });
  }

  // app_operation routing is not server-executable in this commit; the policy
  // already blocks it with app_action_review_handoff_required, so this is a
  // defensive fallthrough.
  return buildResult({
    request,
    policy,
    startedAt,
    completedAt: options.now ?? startedAt,
    outcome: {
      applied: false,
      rolledBack: false,
      reviewHandoff: false,
      blockReasons: ['app_action_review_handoff_required'],
    },
  });
}
