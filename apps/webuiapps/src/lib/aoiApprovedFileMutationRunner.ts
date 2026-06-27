import * as fs from 'fs';
import { createHash } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';
import {
  compareAoiApprovedFileMutationApproval,
  evaluateAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import {
  AoiActionCheckpointError,
  createAoiActionCheckpoint,
  rollbackAoiActionCheckpoint,
  type AoiActionCheckpoint,
} from './aoiActionCheckpoint';
import type {
  AoiApprovedFileMutationPolicy,
  AoiApprovedFileMutationRequest,
  AoiApprovedFileMutationResult,
  AoiFileMutationAuditRecord,
  AoiFileMutationBlockReason,
} from './aoiAutonomyTypes';

// Server-side (Node fs) runner that applies an approved Aoi file mutation behind
// a pre-change checkpoint. Mirrors aoiApprovedCommandRunner.ts: re-derive the
// policy, validate the stored approval, then capture a checkpoint, apply, verify,
// and roll back on any failure. The returned result carries the checkpoint so
// the execution layer can persist it for a later undo.

export interface AoiApprovedFileMutationRunnerOptions {
  workspaceRoot: string;
  approvedPolicy?: AoiApprovedFileMutationPolicy | null;
  now?: number;
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeAuditId(request: AoiApprovedFileMutationRequest, startedAt: number): string {
  return `aoi-file-mutation-${startedAt.toString(36)}-${sha256Hex(
    `${request.sessionPath}:${request.proposalId ?? ''}:${request.operation}:${request.path}:${startedAt}`,
  ).slice(0, 16)}`;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(root, target);
  return diff !== '' && !diff.startsWith('..') && !isAbsolute(diff);
}

function mapCheckpointErrorCode(error: AoiActionCheckpointError): AoiFileMutationBlockReason {
  if (error.code === 'path_escapes_workspace' || error.code === 'symlink_ancestor_escape') {
    return 'path_escapes_workspace';
  }
  if (error.code === 'workspace_root_unresolved') {
    return 'workspace_root_missing';
  }
  return 'checkpoint_failed';
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

interface FileMutationOutcome {
  applied: boolean;
  rolledBack: boolean;
  bytesBefore: number | null;
  bytesAfter: number | null;
  blockReasons: AoiFileMutationBlockReason[];
  checkpoint?: AoiActionCheckpoint;
}

function buildResult(params: {
  request: AoiApprovedFileMutationRequest;
  policy: AoiApprovedFileMutationPolicy;
  startedAt: number;
  completedAt: number;
  outcome: FileMutationOutcome;
}): AoiApprovedFileMutationResult {
  const { request, policy, outcome } = params;
  const ok = outcome.applied && outcome.blockReasons.length === 0;
  const auditRecord: AoiFileMutationAuditRecord = {
    version: 1,
    id: makeAuditId(request, params.startedAt),
    sessionPath: request.sessionPath,
    ...(request.proposalId ? { proposalId: request.proposalId } : {}),
    ...(request.decisionId ? { decisionId: request.decisionId } : {}),
    operation: policy.operation,
    pathLabel: policy.pathLabel,
    pathHash: policy.pathHash,
    purpose: policy.purpose,
    risk: policy.risk,
    allowed: ok,
    blockReasons: [...new Set(outcome.blockReasons)],
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.completedAt - params.startedAt),
    applied: outcome.applied,
    rolledBack: outcome.rolledBack,
    bytesBefore: outcome.bytesBefore,
    bytesAfter: outcome.bytesAfter,
    contentHash: policy.contentHash,
    ...(outcome.checkpoint ? { checkpointId: outcome.checkpoint.id } : {}),
    evidenceRefs: [
      ...new Set([
        `aoi-file-mutation-audit:${makeAuditId(request, params.startedAt)}`,
        ...(request.proposalId ? [`proposal:${request.proposalId}`] : []),
        ...(request.decisionId ? [`decision:${request.decisionId}`] : []),
        ...(outcome.checkpoint ? [`aoi-action-checkpoint:${outcome.checkpoint.id}`] : []),
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
    operation: policy.operation,
    pathLabel: policy.pathLabel,
    applied: outcome.applied,
    rolledBack: outcome.rolledBack,
    bytesBefore: outcome.bytesBefore,
    bytesAfter: outcome.bytesAfter,
    ...(outcome.checkpoint ? { checkpointId: outcome.checkpoint.id } : {}),
    ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
    blockReasons: auditRecord.blockReasons,
    auditRecord,
    evidenceRefs: auditRecord.evidenceRefs,
  };
}

export function applyAoiApprovedFileMutation(
  request: AoiApprovedFileMutationRequest,
  options: AoiApprovedFileMutationRunnerOptions,
): AoiApprovedFileMutationResult {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiApprovedFileMutationPolicy(request);
  const approvalReasons = compareAoiApprovedFileMutationApproval({
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
        bytesBefore: null,
        bytesAfter: null,
        blockReasons: [...policy.blockReasons, ...approvalReasons],
      },
    });
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(resolve(options.workspaceRoot));
  } catch {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: startedAt,
      outcome: {
        applied: false,
        rolledBack: false,
        bytesBefore: null,
        bytesAfter: null,
        blockReasons: ['workspace_root_missing'],
      },
    });
  }

  const target = resolve(realRoot, policy.pathLabel);
  if (!isPathInsideRoot(realRoot, target)) {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: startedAt,
      outcome: {
        applied: false,
        rolledBack: false,
        bytesBefore: null,
        bytesAfter: null,
        blockReasons: ['path_escapes_workspace'],
      },
    });
  }

  let checkpoint: AoiActionCheckpoint;
  try {
    checkpoint = createAoiActionCheckpoint({
      workspaceRoot: realRoot,
      paths: [policy.pathLabel],
      now: startedAt,
      evidenceRefs: request.evidenceRefs,
    });
  } catch (error) {
    const reason =
      error instanceof AoiActionCheckpointError
        ? mapCheckpointErrorCode(error)
        : 'checkpoint_failed';
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: false,
        rolledBack: false,
        bytesBefore: null,
        bytesAfter: null,
        blockReasons: [reason],
      },
    });
  }

  const entry = checkpoint.entries[0];
  const bytesBefore = entry && entry.existedBefore ? (entry.byteLength ?? null) : null;
  const failWithRollback = (reason: AoiFileMutationBlockReason): AoiApprovedFileMutationResult => {
    const rollback = rollbackAoiActionCheckpoint(checkpoint, {
      workspaceRoot: realRoot,
      now: options.now ?? startedAt,
    });
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: false,
        rolledBack: rollback.ok,
        bytesBefore,
        bytesAfter: null,
        blockReasons: rollback.ok ? [reason] : [reason, 'execution_failed'],
        checkpoint,
      },
    });
  };

  try {
    if (policy.operation === 'write') {
      const content = typeof request.content === 'string' ? request.content : '';
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      const after = fs.readFileSync(target, 'utf8');
      if (sha256Hex(after) !== policy.contentHash) {
        return failWithRollback('verification_failed');
      }
    } else if (policy.operation === 'patch') {
      if (!entry || !entry.existedBefore) {
        return failWithRollback('patch_target_missing');
      }
      let text = fs.readFileSync(target, 'utf8');
      for (const op of policy.patchOps ?? []) {
        const expected = op.expectedCount ?? 1;
        if (countOccurrences(text, op.find) !== expected) {
          return failWithRollback('patch_anchor_mismatch');
        }
        text = text.split(op.find).join(op.replace);
      }
      fs.writeFileSync(target, text, 'utf8');
    } else {
      // delete
      if (!entry || !entry.existedBefore) {
        // Nothing to delete; the checkpoint captured an absent file so no state
        // changed. Report blocked without framing it as a rollback.
        return buildResult({
          request,
          policy,
          startedAt,
          completedAt: options.now ?? startedAt,
          outcome: {
            applied: false,
            rolledBack: false,
            bytesBefore,
            bytesAfter: null,
            blockReasons: ['delete_target_missing'],
            checkpoint,
          },
        });
      }
      fs.unlinkSync(target);
      if (fs.existsSync(target)) {
        return failWithRollback('verification_failed');
      }
    }
  } catch {
    return failWithRollback('execution_failed');
  }

  let bytesAfter: number | null = null;
  try {
    bytesAfter = fs.statSync(target).size;
  } catch {
    bytesAfter = null;
  }

  return buildResult({
    request,
    policy,
    startedAt,
    completedAt: options.now ?? startedAt,
    outcome: {
      applied: true,
      rolledBack: false,
      bytesBefore,
      bytesAfter,
      blockReasons: [],
      checkpoint,
    },
  });
}
