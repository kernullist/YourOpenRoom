// Aoi host-bridge file deletion (final roadmap step, deferred to the end per
// the operator's instruction). Deletion is dangerous, so it is the last thing
// implemented and the most constrained (docs/aoi-host-access-design.md).
//
// Safety posture (load-bearing):
//   - RECYCLE BIN ONLY (decision 10-5): Aoi-initiated deletes ALWAYS route
//     through the OS Recycle Bin. There is NO permanent-delete path exposed --
//     so a wrong delete is recoverable, and the "delete is irreversible" threat
//     is downgraded to "restore from the Recycle Bin".
//   - WRITE-ROOT CONSENT: a delete target must resolve inside a registered WRITE
//     root (you may only delete where you may write). realpath re-validation
//     rejects a symlink/junction escape (the target must EXIST and realpath
//     inside a root).
//   - FILES ONLY: this step deletes files, never directory trees (a recursive
//     delete is a far larger blast radius and is out of scope here).
//   - Content-addressed approval (sha256), bound by the caller's single-use
//     store-consume before recycling.
//   - The HP0 gate (auth + kill switch capability `os_file_delete` + the
//     single-use approval store-consume) is enforced by the caller; the runner
//     re-evaluates the path policy and audits every attempt.
//
// Server-only. The path guard + policy are unit-tested with an injectable
// realpath; the runner is exercised with an injected recycle implementation (the
// daemon supplies the real Recycle-Bin call, e.g. via a PowerShell one-liner).
import * as fs from 'fs';
import { basename, isAbsolute, resolve } from 'path';
import { randomUUID } from 'crypto';
import { isAoiPathInsideRoot, type AoiHostRealpathImpl } from './aoiHostFileRead';
import { type AoiHostWriteRoot } from './aoiHostFileWrite';
import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
  type AoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';

export const AOI_HOST_FILE_DELETE_CAPABILITY = 'os_file_delete';
export const AOI_HOST_FILE_DELETE_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const AOI_HOST_FILE_DELETE_IRREVERSIBLE = true;

const MAX_PATH_CHARS = 4096;

export type AoiHostFileDeleteDenyReason =
  | 'missing_path'
  | 'path_not_absolute'
  | 'path_too_long'
  | 'unsafe_basename'
  | 'no_consent_roots'
  | 'not_found'
  | 'outside_consent_roots'
  | 'target_is_directory'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_fingerprint_changed'
  | 'approval_preview_changed'
  | 'recycle_failed';

export interface AoiHostFileDeleteRequest {
  requestedPath: string;
  purpose?: string;
  requestedAt: number;
  evidenceRefs?: string[];
}

export interface AoiHostFileDeleteTargetResolution {
  ok: boolean;
  resolvedPath?: string;
  rootId?: string;
  reason?: AoiHostFileDeleteDenyReason;
}

export interface AoiHostFileDeletePolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiHostFileDeleteDenyReason[];
  resolvedPath: string;
  rootId: string;
  purpose: string;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox: AoiApprovalSandboxPreview;
  expiresAt: number;
}

export interface AoiHostFileDeleteAuditRecord {
  version: 1;
  id: string;
  resolvedPath: string;
  rootId: string;
  purpose: string;
  allowed: boolean;
  blockReasons: AoiHostFileDeleteDenyReason[];
  startedAt: number;
  recycled: boolean;
  approvalFingerprint: string;
  evidenceRefs: string[];
}

export interface AoiHostFileDeleteResult {
  version: 1;
  ok: boolean;
  resolvedPath: string;
  recycled: boolean;
  blockReasons: AoiHostFileDeleteDenyReason[];
  auditRecord: AoiHostFileDeleteAuditRecord;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Resolve an existing delete target inside the write roots, with realpath
// re-validation. The target must exist and be a FILE.
export function resolveAoiHostDeleteTarget(params: {
  roots: readonly AoiHostWriteRoot[];
  requestedPath: string;
  realpathImpl?: AoiHostRealpathImpl;
  statImpl?: (path: string) => { isDirectory: boolean } | null;
}): AoiHostFileDeleteTargetResolution {
  const requested = params.requestedPath;
  if (typeof requested !== 'string' || requested.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }
  if (requested.length > MAX_PATH_CHARS) {
    return { ok: false, reason: 'path_too_long' };
  }
  if (!isAbsolute(requested)) {
    return { ok: false, reason: 'path_not_absolute' };
  }
  const name = basename(resolve(requested));
  if (!name || name === '.' || name === '..') {
    return { ok: false, reason: 'unsafe_basename' };
  }
  if (params.roots.length === 0) {
    return { ok: false, reason: 'no_consent_roots' };
  }
  const realpathImpl = params.realpathImpl ?? ((target: string) => fs.realpathSync.native(target));
  const statImpl =
    params.statImpl ??
    ((path: string) => {
      try {
        return { isDirectory: fs.statSync(path).isDirectory() };
      } catch {
        return null;
      }
    });

  let resolvedTarget: string;
  try {
    resolvedTarget = realpathImpl(resolve(requested));
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  let insideRoot: string | null = null;
  for (const root of params.roots) {
    try {
      const resolvedRoot = realpathImpl(resolve(root.path));
      if (isAoiPathInsideRoot(resolvedRoot, resolvedTarget)) {
        insideRoot = root.id;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!insideRoot) {
    return { ok: false, reason: 'outside_consent_roots' };
  }
  const stat = statImpl(resolvedTarget);
  if (!stat) {
    return { ok: false, reason: 'not_found' };
  }
  if (stat.isDirectory) {
    return { ok: false, reason: 'target_is_directory' };
  }
  return { ok: true, resolvedPath: resolvedTarget, rootId: insideRoot };
}

export function evaluateAoiHostFileDeletePolicy(params: {
  request: AoiHostFileDeleteRequest;
  roots: readonly AoiHostWriteRoot[];
  realpathImpl?: AoiHostRealpathImpl;
  statImpl?: (path: string) => { isDirectory: boolean } | null;
}): AoiHostFileDeletePolicy {
  const request = params.request;
  const purpose =
    normalizeWhitespace(request.purpose ?? '').slice(0, 180) ||
    'Delete a file (to the Recycle Bin).';
  const evidenceRefs = [...new Set(request.evidenceRefs ?? [])].slice(0, 16);
  const resolution = resolveAoiHostDeleteTarget({
    roots: params.roots,
    requestedPath: request.requestedPath,
    ...(params.realpathImpl ? { realpathImpl: params.realpathImpl } : {}),
    ...(params.statImpl ? { statImpl: params.statImpl } : {}),
  });
  const reasons: AoiHostFileDeleteDenyReason[] = [];
  if (!resolution.ok && resolution.reason) {
    reasons.push(resolution.reason);
  }
  const resolvedPath = resolution.resolvedPath ?? '';
  const rootId = resolution.rootId ?? '';

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'workspace',
    targetId: `host-delete:${resolvedPath || request.requestedPath}`,
    intendedMutation: `Delete file "${resolvedPath}" to the Recycle Bin.`,
    dryRunSummary: `Would move "${resolvedPath}" to the Recycle Bin (recoverable).`,
    requiredAuthorityDecisionId: `host-delete:${rootId}:${resolvedPath}`,
    expectedMutationCount: 1,
    recoveryPlan: {
      // The Recycle Bin IS the recovery -- this is what downgrades the threat.
      kind: 'before_snapshot',
      available: true,
      summary: 'The file is moved to the Recycle Bin and can be restored from there.',
      evidenceRefs,
    },
    rollback: {
      required: true,
      note: 'Restore the file from the Recycle Bin to reverse this delete.',
      evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Record the recycled path in the delete audit.',
      check: 'Delete audit receipt is recorded after execution.',
      evidenceRefs,
    },
    command: `recycle ${resolvedPath}`,
    evidenceRefs,
  });
  const blockReasons = [...new Set(reasons)];
  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    resolvedPath,
    rootId,
    purpose,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_HOST_FILE_DELETE_APPROVAL_TTL_MS,
  };
}

export function compareAoiHostDeleteApproval(params: {
  approved: AoiApprovalSandboxPreview | null | undefined;
  current: AoiHostFileDeletePolicy;
  approvedExpiresAt: number | null | undefined;
  now: number;
}): AoiHostFileDeleteDenyReason[] {
  if (!params.approved) {
    return ['approval_missing'];
  }
  if (typeof params.approvedExpiresAt === 'number' && params.approvedExpiresAt < params.now) {
    return ['approval_expired'];
  }
  const sandboxReasons = compareAoiApprovalSandboxPreviews({
    approved: params.approved,
    current: params.current.approvalSandbox,
  });
  if (sandboxReasons.length === 0) {
    return [];
  }
  return sandboxReasons.includes('approval_fingerprint_changed')
    ? ['approval_fingerprint_changed']
    : ['approval_preview_changed'];
}

// The daemon supplies the real Recycle-Bin move; returns true on success.
export type AoiHostRecycleImpl = (path: string) => boolean;

function makeDeleteAuditId(rootId: string, startedAt: number): string {
  return `aoi-host-delete-${startedAt.toString(36)}-${randomUUID().slice(0, 8)}-${rootId || 'x'}`;
}

function blockedDeleteResult(
  policy: AoiHostFileDeletePolicy,
  blockReasons: AoiHostFileDeleteDenyReason[],
  startedAt: number,
): AoiHostFileDeleteResult {
  const auditRecord: AoiHostFileDeleteAuditRecord = {
    version: 1,
    id: makeDeleteAuditId(policy.rootId, startedAt),
    resolvedPath: policy.resolvedPath,
    rootId: policy.rootId,
    purpose: policy.purpose,
    allowed: false,
    blockReasons: [...new Set(blockReasons)],
    startedAt,
    recycled: false,
    approvalFingerprint: policy.approvalFingerprint,
    evidenceRefs: policy.approvalSandbox.evidenceRefs,
  };
  return {
    version: 1,
    ok: false,
    resolvedPath: policy.resolvedPath,
    recycled: false,
    blockReasons: auditRecord.blockReasons,
    auditRecord,
  };
}

export interface RunAoiHostFileDeleteOptions {
  request: AoiHostFileDeleteRequest;
  roots: readonly AoiHostWriteRoot[];
  approvedSandbox: AoiApprovalSandboxPreview | null | undefined;
  approvedExpiresAt?: number | null;
  now?: number;
  realpathImpl?: AoiHostRealpathImpl;
  statImpl?: (path: string) => { isDirectory: boolean } | null;
  // The ONLY delete path: move to the Recycle Bin. There is no permanent-delete
  // variant here by design.
  recycleImpl: AoiHostRecycleImpl;
}

export function runAoiHostFileDelete(
  options: RunAoiHostFileDeleteOptions,
): AoiHostFileDeleteResult {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiHostFileDeletePolicy({
    request: options.request,
    roots: options.roots,
    ...(options.realpathImpl ? { realpathImpl: options.realpathImpl } : {}),
    ...(options.statImpl ? { statImpl: options.statImpl } : {}),
  });
  const approvalReasons = compareAoiHostDeleteApproval({
    approved: normalizeAoiApprovalSandboxPreview(options.approvedSandbox),
    current: policy,
    approvedExpiresAt: options.approvedExpiresAt,
    now: startedAt,
  });
  const blockReasons = [...policy.blockReasons, ...approvalReasons];
  if (blockReasons.length > 0 || !policy.resolvedPath) {
    return blockedDeleteResult(policy, blockReasons, startedAt);
  }

  let recycled = false;
  try {
    recycled = options.recycleImpl(policy.resolvedPath) === true;
  } catch {
    recycled = false;
  }
  if (!recycled) {
    return blockedDeleteResult(policy, ['recycle_failed'], startedAt);
  }
  const auditRecord: AoiHostFileDeleteAuditRecord = {
    version: 1,
    id: makeDeleteAuditId(policy.rootId, startedAt),
    resolvedPath: policy.resolvedPath,
    rootId: policy.rootId,
    purpose: policy.purpose,
    allowed: true,
    blockReasons: [],
    startedAt,
    recycled: true,
    approvalFingerprint: policy.approvalFingerprint,
    evidenceRefs: policy.approvalSandbox.evidenceRefs,
  };
  return {
    version: 1,
    ok: true,
    resolvedPath: policy.resolvedPath,
    recycled: true,
    blockReasons: [],
    auditRecord,
  };
}
