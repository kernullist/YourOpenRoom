import * as fs from 'fs';
import { createHash } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';
import {
  compareAoiApprovedFileMutationApproval,
  evaluateAoiApprovedFileMutationPolicy,
  hashAoiFileMutationContent,
} from './aoiApprovedFileMutationPolicy';
import {
  AoiActionCheckpointError,
  createAoiActionCheckpoint,
  rollbackAoiActionCheckpoint,
  type AoiActionCheckpoint,
  type AoiActionCheckpointRollbackResult,
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
  // Controlled-real harness injection. Production callers leave this unset.
  afterMutationBeforeValidation?: (targetPath: string) => void;
  // Failure-path injection for deterministic rollback tests. Production callers
  // always use rollbackAoiActionCheckpoint.
  rollbackCheckpoint?: (
    checkpoint: AoiActionCheckpoint,
    options: { workspaceRoot: string; now?: number },
  ) => AoiActionCheckpointRollbackResult;
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintAoiActionCheckpoint(checkpoint: AoiActionCheckpoint): string {
  return sha256Hex(
    JSON.stringify({
      version: checkpoint.version,
      workspaceRootHash: checkpoint.workspaceRootHash,
      entries: checkpoint.entries.map((entry) => ({
        pathHash: entry.pathHash,
        existedBefore: entry.existedBefore,
        byteLength: entry.byteLength ?? 0,
        sha256: entry.sha256 ?? 'absent',
      })),
    }),
  );
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
  checkpointFingerprint?: string;
  targetBeforeSha256?: string | 'absent';
  targetAfterSha256?: string;
  validationStatus?: 'not_run' | 'passed' | 'failed';
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
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
  const auditId = makeAuditId(request, params.startedAt);
  const validationStatus = outcome.validationStatus ?? 'not_run';
  const rollbackAttempted = outcome.rollbackAttempted === true;
  const rollbackSucceeded = outcome.rollbackSucceeded === true;
  const auditRecord: AoiFileMutationAuditRecord = {
    version: 1,
    id: auditId,
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
    ...(outcome.checkpointFingerprint
      ? { checkpointFingerprint: outcome.checkpointFingerprint }
      : {}),
    ...(outcome.targetBeforeSha256 ? { targetBeforeSha256: outcome.targetBeforeSha256 } : {}),
    ...(outcome.targetAfterSha256 ? { targetAfterSha256: outcome.targetAfterSha256 } : {}),
    validationStatus,
    rollbackAttempted,
    rollbackSucceeded,
    evidenceRefs: [
      ...new Set([
        `aoi-file-mutation-audit:${auditId}`,
        ...(request.proposalId ? [`proposal:${request.proposalId}`] : []),
        ...(request.decisionId ? [`decision:${request.decisionId}`] : []),
        ...(outcome.checkpoint ? [`aoi-action-checkpoint:${outcome.checkpoint.id}`] : []),
        ...(outcome.checkpointFingerprint
          ? [`aoi-action-checkpoint-fingerprint:${outcome.checkpointFingerprint}`]
          : []),
        ...(validationStatus !== 'not_run'
          ? [`aoi-file-validation:${auditId}:${validationStatus}`]
          : []),
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
    ...(outcome.checkpointFingerprint
      ? { checkpointFingerprint: outcome.checkpointFingerprint }
      : {}),
    ...(outcome.targetBeforeSha256 ? { targetBeforeSha256: outcome.targetBeforeSha256 } : {}),
    ...(outcome.targetAfterSha256 ? { targetAfterSha256: outcome.targetAfterSha256 } : {}),
    validationStatus,
    rollbackAttempted,
    rollbackSucceeded,
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
  const checkpointFingerprint = fingerprintAoiActionCheckpoint(checkpoint);
  const targetBeforeSha256 = entry?.existedBefore ? entry.sha256 : 'absent';
  const blockAfterCheckpoint = (
    reason: AoiFileMutationBlockReason,
    validationStatus: 'not_run' | 'failed' = 'not_run',
  ): AoiApprovedFileMutationResult =>
    buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: false,
        rolledBack: false,
        bytesBefore,
        bytesAfter: null,
        blockReasons: [reason],
        checkpoint,
        checkpointFingerprint,
        ...(targetBeforeSha256 ? { targetBeforeSha256 } : {}),
        validationStatus,
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
    });

  if (policy.validationPlan && targetBeforeSha256 !== policy.validationPlan.expectedBeforeSha256) {
    return blockAfterCheckpoint('target_fingerprint_mismatch', 'failed');
  }

  const failWithRollback = (
    reason: AoiFileMutationBlockReason,
    targetAfterSha256?: string,
  ): AoiApprovedFileMutationResult => {
    const rollback = (options.rollbackCheckpoint ?? rollbackAoiActionCheckpoint)(checkpoint, {
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
        blockReasons: rollback.ok ? [reason] : [reason, 'rollback_failed'],
        checkpoint,
        checkpointFingerprint,
        ...(targetBeforeSha256 ? { targetBeforeSha256 } : {}),
        ...(targetAfterSha256 ? { targetAfterSha256 } : {}),
        validationStatus: 'failed',
        rollbackAttempted: true,
        rollbackSucceeded: rollback.ok,
      },
    });
  };

  let targetAfterSha256: string | undefined;
  try {
    if (policy.operation === 'write') {
      const content = typeof request.content === 'string' ? request.content : '';
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      options.afterMutationBeforeValidation?.(target);
      const after = fs.readFileSync(target);
      targetAfterSha256 = sha256Hex(after);
      const expectedAfterSha256 =
        policy.validationPlan?.expectedAfterSha256 ?? sha256Hex(Buffer.from(content, 'utf8'));
      if (
        hashAoiFileMutationContent(after.toString('utf8')) !== policy.contentHash ||
        targetAfterSha256 !== expectedAfterSha256
      ) {
        return failWithRollback('verification_failed', targetAfterSha256);
      }
    } else if (policy.operation === 'patch') {
      if (!entry || !entry.existedBefore) {
        return blockAfterCheckpoint('patch_target_missing', 'failed');
      }
      let text = fs.readFileSync(target, 'utf8');
      for (const op of policy.patchOps ?? []) {
        const expected = op.expectedCount ?? 1;
        if (countOccurrences(text, op.find) !== expected) {
          return blockAfterCheckpoint('patch_anchor_mismatch', 'failed');
        }
        text = text.split(op.find).join(op.replace);
      }
      const expectedAfterSha256 =
        policy.validationPlan?.expectedAfterSha256 ?? sha256Hex(Buffer.from(text, 'utf8'));
      fs.writeFileSync(target, text, 'utf8');
      options.afterMutationBeforeValidation?.(target);
      const after = fs.readFileSync(target);
      targetAfterSha256 = sha256Hex(after);
      if (targetAfterSha256 !== expectedAfterSha256) {
        return failWithRollback('verification_failed', targetAfterSha256);
      }
    } else {
      // delete
      if (!entry || !entry.existedBefore) {
        return blockAfterCheckpoint('delete_target_missing', 'failed');
      }
      fs.unlinkSync(target);
      options.afterMutationBeforeValidation?.(target);
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
      checkpointFingerprint,
      ...(targetBeforeSha256 ? { targetBeforeSha256 } : {}),
      ...(targetAfterSha256 ? { targetAfterSha256 } : {}),
      validationStatus: 'passed',
      rollbackAttempted: false,
      rollbackSucceeded: false,
    },
  });
}
