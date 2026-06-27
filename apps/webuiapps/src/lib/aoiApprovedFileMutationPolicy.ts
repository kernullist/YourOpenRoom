import { createHash } from 'crypto';
import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';
import type {
  AoiApprovedFileMutationPolicy,
  AoiApprovedFileMutationRequest,
  AoiAutonomyRisk,
  AoiFileMutationBlockReason,
  AoiFileMutationOperation,
  AoiFileMutationPatchOp,
} from './aoiAutonomyTypes';

// Policy + content-addressed approval fingerprint for approved Aoi file
// mutations (file_write / file_patch). This is the file analog of
// aoiApprovedCommandPolicy.ts. The fingerprint is derived only from the
// operation, normalized relative path, and content/patch bytes -- never from a
// specific checkpoint -- so it is stable between accept and execute. The
// pre-change checkpoint is captured by the runner at apply time.

export const AOI_FILE_MUTATION_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const AOI_MAX_FILE_MUTATION_CONTENT_BYTES = 256 * 1024;
export const AOI_MAX_FILE_MUTATION_PATCH_OPS = 32;
export const AOI_MAX_FILE_MUTATION_PATCH_BYTES = 256 * 1024;

const MAX_PURPOSE_CHARS = 180;
const SAFE_RELATIVE_FILE_PATH = /^[A-Za-z0-9._/-]+$/;
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', '.ssh', '.aws']);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Short(value: string): string {
  return sha256(value).slice(0, 16);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePurpose(value: unknown): string {
  const purpose =
    typeof value === 'string' ? normalizeWhitespace(value).slice(0, MAX_PURPOSE_CHARS) : '';
  return purpose || 'Apply an approved Aoi file mutation.';
}

export function normalizeAoiFileMutationPath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const replaced = value.trim().replace(/\\/g, '/');
  // Strip a leading "./" and trailing slashes, but never strip a leading "/":
  // an absolute path must stay detectable so it can be rejected.
  return replaced.replace(/^\.\/+/, '').replace(/\/+$/g, '');
}

function normalizeOperation(value: unknown): AoiFileMutationOperation | '' {
  return value === 'write' || value === 'patch' || value === 'delete' ? value : '';
}

function normalizePatchOps(value: unknown): AoiFileMutationPatchOp[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ops: AoiFileMutationPatchOp[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Partial<AoiFileMutationPatchOp>;
    if (typeof candidate.find !== 'string' || typeof candidate.replace !== 'string') {
      continue;
    }
    const expectedCount =
      typeof candidate.expectedCount === 'number' &&
      Number.isInteger(candidate.expectedCount) &&
      candidate.expectedCount >= 1
        ? candidate.expectedCount
        : 1;
    ops.push({ find: candidate.find, replace: candidate.replace, expectedCount });
  }
  return ops;
}

function collectPathBlockReasons(pathLabel: string): AoiFileMutationBlockReason[] {
  const reasons: AoiFileMutationBlockReason[] = [];
  if (!pathLabel) {
    reasons.push('missing_path');
    return reasons;
  }
  if (pathLabel.startsWith('/') || /^[A-Za-z]:\//.test(pathLabel)) {
    reasons.push('path_not_relative');
  }
  const segments = pathLabel.split('/');
  if (segments.some((segment) => segment === '..')) {
    reasons.push('path_escapes_workspace');
  }
  if (!SAFE_RELATIVE_FILE_PATH.test(pathLabel)) {
    reasons.push('unsafe_path');
  }
  if (
    segments.some(
      (segment) => PROTECTED_SEGMENTS.has(segment) || segment.toLowerCase().startsWith('.env'),
    )
  ) {
    reasons.push('protected_path');
  }
  return reasons;
}

function collectContentBlockReasons(request: AoiApprovedFileMutationRequest): {
  reasons: AoiFileMutationBlockReason[];
  contentHash: string;
  byteLength: number;
  patchOps?: AoiFileMutationPatchOp[];
} {
  if (request.operation === 'write') {
    if (typeof request.content !== 'string') {
      return { reasons: ['missing_content'], contentHash: sha256(''), byteLength: 0 };
    }
    const byteLength = Buffer.byteLength(request.content, 'utf8');
    const reasons: AoiFileMutationBlockReason[] = [];
    if (byteLength > AOI_MAX_FILE_MUTATION_CONTENT_BYTES) {
      reasons.push('content_too_large');
    }
    return { reasons, contentHash: sha256(request.content), byteLength };
  }

  if (request.operation === 'patch') {
    const ops = normalizePatchOps(request.patchOps);
    if (!Array.isArray(request.patchOps) || request.patchOps.length === 0) {
      return { reasons: ['missing_patch_ops'], contentHash: sha256('[]'), byteLength: 0 };
    }
    const reasons: AoiFileMutationBlockReason[] = [];
    if (ops.length !== request.patchOps.length || ops.some((op) => op.find.length === 0)) {
      reasons.push('invalid_patch_op');
    }
    if (request.patchOps.length > AOI_MAX_FILE_MUTATION_PATCH_OPS) {
      reasons.push('too_many_patch_ops');
    }
    const byteLength = ops.reduce(
      (total, op) =>
        total + Buffer.byteLength(op.find, 'utf8') + Buffer.byteLength(op.replace, 'utf8'),
      0,
    );
    if (byteLength > AOI_MAX_FILE_MUTATION_PATCH_BYTES) {
      reasons.push('patch_op_too_large');
    }
    return {
      reasons,
      contentHash: sha256(JSON.stringify(ops)),
      byteLength,
      patchOps: ops,
    };
  }

  if (request.operation === 'delete') {
    // A delete is fully specified by its path; there is no content to bind.
    return { reasons: [], contentHash: sha256(''), byteLength: 0 };
  }

  return { reasons: ['unsupported_operation'], contentHash: sha256(''), byteLength: 0 };
}

export function createAoiApprovedFileMutationRequest(params: {
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  operation: unknown;
  path: unknown;
  content?: unknown;
  patchOps?: unknown;
  purpose?: unknown;
  risk?: AoiAutonomyRisk;
  requestedAt?: number;
  evidenceRefs?: string[];
}): AoiApprovedFileMutationRequest {
  const operation = normalizeOperation(params.operation) || 'write';
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(params.proposalId ? { proposalId: params.proposalId } : {}),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
    operation,
    path: normalizeAoiFileMutationPath(params.path),
    ...(typeof params.content === 'string' ? { content: params.content } : {}),
    ...(Array.isArray(params.patchOps) ? { patchOps: normalizePatchOps(params.patchOps) } : {}),
    purpose: normalizePurpose(params.purpose),
    risk: params.risk ?? 'high',
    requestedAt: params.requestedAt ?? Date.now(),
    evidenceRefs: [...new Set(params.evidenceRefs ?? [])].slice(0, 16),
  };
}

export function evaluateAoiApprovedFileMutationPolicy(
  request: AoiApprovedFileMutationRequest,
): AoiApprovedFileMutationPolicy {
  const operation = normalizeOperation(request.operation);
  const pathLabel = normalizeAoiFileMutationPath(request.path);
  const purpose = normalizePurpose(request.purpose);
  const purposeHash = sha256Short(purpose);
  const pathHash = sha256Short(pathLabel || 'missing-path');

  const reasons: AoiFileMutationBlockReason[] = [];
  if (!operation) {
    reasons.push('unsupported_operation');
  }
  reasons.push(...collectPathBlockReasons(pathLabel));
  const contentResult = collectContentBlockReasons(request);
  reasons.push(...contentResult.reasons);

  const blockReasons = [...new Set(reasons)];
  const resolvedOperation: AoiFileMutationOperation = operation || 'write';
  const contentHash = contentResult.contentHash;
  const byteLength = contentResult.byteLength;
  const safePathLabel = pathLabel || 'missing-path';
  const operationLabel =
    resolvedOperation === 'write' ? 'Write' : resolvedOperation === 'patch' ? 'Patch' : 'Delete';
  const dryRunSummary =
    resolvedOperation === 'write'
      ? `Would create or replace ${safePathLabel} with ${byteLength} bytes of approved content.`
      : resolvedOperation === 'patch'
        ? `Would apply ${contentResult.patchOps?.length ?? 0} anchored text patch op(s) to ${safePathLabel}.`
        : `Would delete ${safePathLabel}; a pre-change checkpoint is captured for rollback.`;

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'workspace',
    targetId: `${resolvedOperation}:${safePathLabel}`,
    intendedMutation: `${operationLabel} ${safePathLabel} (${byteLength} bytes, content sha256 ${contentHash.slice(
      0,
      16,
    )}).`,
    dryRunSummary,
    requiredAuthorityDecisionId: `approved-file-mutation:${sha256Short(
      [resolvedOperation, pathHash, contentHash, request.risk].join('|'),
    )}`,
    expectedMutationCount: 1,
    recoveryPlan: {
      kind: 'before_snapshot',
      available: true,
      summary:
        'A pre-change checkpoint of the target file is captured before applying and restored automatically if the mutation fails verification.',
      evidenceRefs: request.evidenceRefs,
    },
    rollback: {
      required: true,
      note: 'The pre-change checkpoint is restored if the mutation fails or is later undone.',
      evidenceRefs: request.evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Re-read the file, confirm the mutation applied, and record the file-mutation audit.',
      check: 'File-mutation audit receipt is recorded after execution.',
      evidenceRefs: request.evidenceRefs,
    },
    evidenceRefs: request.evidenceRefs,
  });

  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    operation: resolvedOperation,
    path: pathLabel,
    pathLabel,
    pathHash,
    contentHash,
    byteLength,
    ...(contentResult.patchOps ? { patchOps: contentResult.patchOps } : {}),
    purpose,
    purposeHash,
    risk: request.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_FILE_MUTATION_APPROVAL_TTL_MS,
    rationale: blockReasons.length
      ? ['File mutation is blocked until it matches the approved file-mutation policy.']
      : [
          `Approved ${resolvedOperation} of ${pathLabel} (${byteLength} bytes) under L5 with a pre-change checkpoint.`,
        ],
  };
}

export function normalizeAoiApprovedFileMutationPolicy(
  value: unknown,
): AoiApprovedFileMutationPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiApprovedFileMutationPolicy>;
  if (
    raw.version !== 1 ||
    typeof raw.allowed !== 'boolean' ||
    !Array.isArray(raw.blockReasons) ||
    (raw.operation !== 'write' && raw.operation !== 'patch' && raw.operation !== 'delete') ||
    typeof raw.path !== 'string' ||
    typeof raw.pathLabel !== 'string' ||
    typeof raw.pathHash !== 'string' ||
    typeof raw.contentHash !== 'string' ||
    typeof raw.byteLength !== 'number' ||
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
  return {
    version: 1,
    allowed: raw.allowed,
    blockReasons: raw.blockReasons.filter(
      (item): item is AoiFileMutationBlockReason => typeof item === 'string',
    ),
    operation: raw.operation,
    path: raw.path,
    pathLabel: raw.pathLabel,
    pathHash: raw.pathHash,
    contentHash: raw.contentHash,
    byteLength: raw.byteLength,
    ...(Array.isArray(raw.patchOps) ? { patchOps: normalizePatchOps(raw.patchOps) } : {}),
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

export function compareAoiApprovedFileMutationApproval(params: {
  approved: AoiApprovedFileMutationPolicy | undefined;
  current: AoiApprovedFileMutationPolicy;
  now: number;
}): AoiFileMutationBlockReason[] {
  const approved = params.approved;
  if (!approved) {
    return ['approval_missing', 'approval_sandbox_missing'];
  }
  const reasons: AoiFileMutationBlockReason[] = [];
  if (approved.expiresAt < params.now) {
    reasons.push('approval_expired');
  }
  if (approved.operation !== params.current.operation) {
    reasons.push('approval_operation_changed');
  }
  if (approved.pathHash !== params.current.pathHash) {
    reasons.push('approval_path_changed');
  }
  if (approved.contentHash !== params.current.contentHash) {
    reasons.push('approval_content_changed');
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
    reasons.push(reason as AoiFileMutationBlockReason);
  }
  if (
    approved.approvalFingerprint !== params.current.approvalFingerprint &&
    !reasons.includes('approval_content_changed') &&
    !reasons.includes('approval_path_changed')
  ) {
    reasons.push('approval_fingerprint_changed');
  }
  return [...new Set(reasons)];
}
